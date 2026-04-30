const supabase = require('../config/supabaseClient');
require('dotenv').config();

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || `http://127.0.0.1:${process.env.PYTHON_PORT || 8000}`;

/**
 * Handles the AI similarity matching for cleaned merchant strings.
 * Waterfall: Personal Vector (3.1) → Global Keyword Rules (3.1.5) → Global Vector (3.2)
 *
 * @param {string} cleanString - The merchant name or VPA string.
 * @param {string} userId - The UUID of the authenticated user.
 * @param {string} transactionType - 'DEBIT' or 'CREDIT' to filter by balance_nature.
 * @returns {object|null} Returns { offset_account_id, categorised_by, confidence_score } if matched, else null.
 */
async function findVectorMatch(cleanString, userId, transactionType) {
  try {
    const cleanMerchant = sanitizeMerchantString(cleanString);
    if (!cleanMerchant || !userId) return null;

    const uppercaseString = cleanMerchant.toUpperCase();
    // Raw fallback: some keywords live in segments dropped by sanitizeMerchantString
    // (e.g. user notes in UPI/DR/.../Cake format). Test both so nothing is silently lost.
    const uppercaseRaw = cleanString ? cleanString.toUpperCase() : uppercaseString;

    // 🛡️ MEANINGFULNESS GUARD
    // If the cleaned string is a single token with no spaces (likely a person name
    // like MRVARADVIDYADHAR) AND is not a known short keyword, skip G_VEC entirely.
    // Person names produce embeddings that match random categories at low threshold.
    const isMeaningfulString = (
      uppercaseString.includes(' ') ||   // Multi-word = probably meaningful
      uppercaseString.length <= 18       // Increased threshold: IRCTCAPP (8), BHARTPEME (9), etc. are merchants
    );
    // If single long token with no spaces, it is almost certainly a person name
    const looksLikePersonName = !isMeaningfulString;

    // 1. Embedding Generation (Python ML Microservice)
    const response = await fetch(`${ML_SERVICE_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: uppercaseString })
    });

    if (!response.ok) {
      throw new Error(`Embedding generation failed with status: ${response.status}`);
    }

    const { embedding } = await response.json();
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('Failed to retrieve 384-dimensional array embedding');
    }

    // ------------------------------------------
    // 🛡️ STAGE 3.1: PERSONAL VECTOR CACHE
    // ------------------------------------------
    // User's own history always takes highest priority.
    const { data: pData, error: pError } = await supabase.rpc('match_personal_vectors', {
      p_user_id: userId,
      query_embedding: embedding,
      match_threshold: 0.35,
      match_count: 1
    });

    if (pError) {
      console.error('❌ findVectorMatch (Personal) rpc error:', pError);
    } else if (pData && pData.length > 0) {
      return {
        offset_account_id: pData[0].account_id,
        confidence_score: 1.00,
        categorised_by: 'P_VEC'
      };
    }

    // ------------------------------------------
    // 🔑 STAGE 3.1.1: GLOBAL KEYWORD RULES
    // ------------------------------------------
    // Highest priority for global rules. This ensures specific keywords 
    // (like GST or GOOGLEWORKSP) always win before fuzzy or cache matches.
    const { data: keywordRules, error: keywordError } = await supabase
      .from('global_keyword_rules')
      .select('keyword, match_type, target_template_id, priority')
      .eq('is_active', true)
      .order('priority', { ascending: false });

    if (keywordRules && keywordRules.length > 0) {
      console.debug(`🔍 G_KEY: Evaluating ${keywordRules.length} rules against "${uppercaseString}"`);
      for (const rule of keywordRules) {
        const keyword = rule.keyword.toUpperCase();
        let isMatch = false;
        if (rule.match_type === 'EXACT') {
          // EXACT only tests sanitized form to avoid matching raw junk
          isMatch = (uppercaseString === keyword);
        } else {
          const regex = new RegExp(`\\b${keyword}S?\\b`, 'i');
          // Two-pass: sanitized first, then raw — catches keywords in dropped UPI note segments
          isMatch = regex.test(uppercaseString) || regex.test(uppercaseRaw);
        }

        if (!isMatch) continue;

        console.debug(`🎯 G_KEY match found: "${keyword}" for "${uppercaseString}"`);

        const offset_account_id = await resolveAccountFromTemplate(rule.target_template_id, userId);
        if (offset_account_id) {
          console.info(`✅ G_KEY winner: "${keyword}" → template:${rule.target_template_id} → account:${offset_account_id}`);
          return {
            offset_account_id,
            confidence_score: 0.95,
            categorised_by: 'G_KEY'
          };
        }
      }
    }

    // ------------------------------------------
    // ⚡ STAGE 3.1.2: TRIPLE-THREAT (Literal Only)
    // ------------------------------------------
    // High-priority exact matches from the global cache.
    const { data: globalCache } = await supabase
      .from('global_vector_cache')
      .select('clean_name, target_template_id')
      .eq('is_verified', true);

    if (globalCache) {
      for (const entry of globalCache) {
        const cacheWord = entry.clean_name.toUpperCase();
        
        // A. LITERAL MATCH
        const isLiteralMatch = cacheWord.length >= 10 
          ? uppercaseString.includes(cacheWord)
          : new RegExp(`\\b${cacheWord}S?\\b`, 'i').test(uppercaseString);

        if (isLiteralMatch) {
          const offset_account_id = await resolveAccountFromTemplate(entry.target_template_id, userId);
          if (offset_account_id) {
            console.info(`🎯 Triple-Threat Winner: G_KEY on "${entry.target_template_id}" for "${uppercaseString.slice(0, 50)}"`);
            return {
              offset_account_id,
              confidence_score: 1.0,
              categorised_by: 'G_KEY'
            };
          }
        }
      }
    }

    // ------------------------------------------
    // ⚡ STAGE 3.1.6: TRIPLE-THREAT (Fuzzy Fallback)
    // ------------------------------------------
    // Only runs if no exact or keyword match was found.
    if (globalCache) {
      for (const entry of globalCache) {
        const cacheWord = entry.clean_name.toUpperCase();
        if (cacheWord.length <= 3) continue; // Skip short words to avoid "TAX" -> "TAXI" errors

        const txnWords = uppercaseString.split(/[- ]/);
        for (const w of txnWords) {
          if (w.length <= 3) continue; 
          
          let score = stringOverlapScore(w, cacheWord);
          if (w.startsWith(cacheWord) || cacheWord.startsWith(w)) score += 0.15;

          if (score > 0.85) {
            const offset_account_id = await resolveAccountFromTemplate(entry.target_template_id, userId);
            if (offset_account_id) {
              console.info(`🎯 Triple-Threat Winner: G_VEC (Fuzzy) on "${entry.target_template_id}" for "${uppercaseString.slice(0, 50)}"`);
              return {
                offset_account_id,
                confidence_score: 0.90,
                categorised_by: 'G_VEC'
              };
            }
          }
        }
      }
    }

    // ------------------------------------------
    // 🌐 STAGE 3.2: GLOBAL VECTOR CACHE Fallback
    // ------------------------------------------
    // Last resort: fuzzy semantic similarity against the global curated vector library.
    // SKIP entirely if the string looks like a person name — vectors will match garbage at low threshold.
    if (looksLikePersonName) {
      console.debug(`🚫 G_VEC skipped: "${uppercaseString}" looks like a person name.`);
      return null;
    }

    const { data: gData, error: gError } = await supabase.rpc('match_vectors', {
      query_embedding: embedding,
      match_threshold: 0.55,
      match_count: 1
    });

    if (gError) {
      console.error('❌ findVectorMatch (Global) rpc error:', gError);
      throw gError;
    }

    if (gData && gData.length > 0) {
      const bestGMatch = gData[0];
      console.debug(`🌐 G_VEC match found: "${bestGMatch.clean_name}" (${bestGMatch.similarity.toFixed(2)}) for "${uppercaseString.slice(0, 50)}"`);
      
      const offset_account_id = await resolveAccountFromTemplate(bestGMatch.target_template_id, userId);
      if (offset_account_id) {
        return {
          offset_account_id,
          confidence_score: bestGMatch.similarity,
          categorised_by: 'G_VEC'
        };
      }
    } else {
      console.debug(`🌐 G_VEC: No match above threshold (0.75) for "${uppercaseString.slice(0, 50)}"`);
    }

    return null;
  } catch (err) {
    console.error('❌ findVectorMatch encountered an error:', err.message);
    return null;
  }
}

/**
 * findVectorMatchWithEmbedding
 * ─────────────────────────────────────────────────────────────────────────────
 * Same waterfall as findVectorMatch() but accepts a pre-computed embedding
 * array directly — skips the /embed ML call entirely.
 *
 * Used by autoPipelineController and bulkController when a staging embedding
 * is already available from the merchant grouping job.
 *
 * @param {number[]} embedding      - Pre-computed float embedding array.
 * @param {string}   userId         - UUID of the authenticated user.
 * @param {string}   balanceNature  - 'DEBIT' or 'CREDIT'.
 * @returns {object|null} { offset_account_id, categorised_by, confidence_score } or null.
 */
async function findVectorMatchWithEmbedding(embedding, userId, balanceNature, cleanName = null) {
  try {
    const cleanMerchant = cleanName ? sanitizeMerchantString(cleanName) : null;
    if (!embedding || !Array.isArray(embedding) || !userId) return null;

    // ── Stage 3.1: PERSONAL VECTOR CACHE ──────────────────────────────────────
    // Threshold 0.35 — personal history is trusted at lower similarity
    const { data: pData, error: pError } = await supabase.rpc('match_personal_vectors', {
      p_user_id: userId,
      query_embedding: embedding,
      match_threshold: 0.75,
      match_count: 1
    });

    if (pError) {
      console.error('❌ findVectorMatchWithEmbedding (Personal) rpc error:', pError);
    } else if (pData && pData.length > 0) {
      return {
        offset_account_id: pData[0].account_id,
        confidence_score: 1.00,
        categorised_by: 'P_VEC'
      };
    }

    // ── Stage 3.1.5: GLOBAL KEYWORD RULES ────────────────────────────────────
    // High-confidence deterministic matching for known merchants (e.g. SWIGGY, ZOMATO, AIRTEL).
    // Runs only when cleanName is available; silently skipped otherwise.
    if (cleanName) {
      // Use the sanitized version as primary match target
      const uppercaseCleanName = sanitizeMerchantString(cleanName).toUpperCase();
      // Raw fallback: sanitizeMerchantString can drop UPI note segments (e.g. UPI/DR/.../Cake)
      // Two-pass matching ensures keywords anywhere in the original string are still caught.
      const uppercaseRawName = cleanName.toUpperCase();
      
      // MEANINGFULNESS GUARD for bulk pipeline
      const looksLikePersonNameBulk = (
        !uppercaseCleanName.includes(' ') &&
        uppercaseCleanName.length > 12
      );
      const { data: keywordRules } = await supabase
        .from('global_keyword_rules')
        .select('keyword, match_type, target_template_id, priority')
        .eq('is_active', true)
        .order('priority', { ascending: false });

      if (keywordRules && keywordRules.length > 0) {
        for (const rule of keywordRules) {
          const keyword = rule.keyword.toUpperCase();
          
          let isMatch = false;
          if (rule.match_type === 'EXACT') {
            // EXACT only tests sanitized form to avoid matching raw junk
            isMatch = (uppercaseCleanName === keyword);
          } else {
            if (keyword.length < 5) {
              // Support trailing 's' for short words (e.g. EGG vs EGGS)
              const regex = new RegExp(`\\b${keyword}S?\\b`, 'i');
              // Two-pass: sanitized first, raw fallback for dropped segments
              isMatch = regex.test(uppercaseCleanName) || regex.test(uppercaseRawName);
            } else {
              isMatch = uppercaseCleanName.includes(keyword) || uppercaseRawName.includes(keyword);
            }
          }

          if (!isMatch) continue;

          console.debug(`🔑 Keyword rule matched: "${keyword}" (priority:${rule.priority}, template:${rule.target_template_id}) on "${uppercaseCleanName.slice(0, 60)}"`);

          const offset_account_id = await resolveAccountFromTemplate(rule.target_template_id, userId);

          if (offset_account_id) {
            console.info(`✅ G_KEY winner: "${keyword}" → template:${rule.target_template_id} → account:${offset_account_id}`);
            return {
              offset_account_id,
              confidence_score: 0.95,
              categorised_by: 'G_KEY'
            };
          }

          // Template match found but no active user account mapped to this template
          console.debug(`⚠️ Keyword rule "${keyword}" (template:${rule.target_template_id}) found, but no active account mapped for this user.`);
        }
      }
    }

    // ── Stage 3.2: GLOBAL VECTOR CACHE ───────────────────────────────────────
    // Threshold 0.78 — high confidence floor to avoid person name false positives.
    // Skip entirely if cleanName looks like a person name.
    if (cleanName) {
      const sanitizedForGuard = sanitizeMerchantString(cleanName).toUpperCase();
      if (!sanitizedForGuard.includes(' ') && sanitizedForGuard.length > 12) {
        console.debug(`🚫 G_VEC skipped (bulk): "${sanitizedForGuard}" looks like a person name.`);
        return null;
      }
    }

    const { data: gData, error: gError } = await supabase.rpc('match_vectors', {
      query_embedding: embedding,
      match_threshold: 0.75,
      match_count: 1
    });

    if (gError) {
      console.error('❌ findVectorMatchWithEmbedding (Global) rpc error:', gError);
      return null;
    }

    if (gData && gData.length > 0) {
      const targetTemplateId = gData[0].target_template_id;

      const offset_account_id = await resolveAccountFromTemplate(targetTemplateId, userId);

      if (offset_account_id) {
        return {
          offset_account_id,
          confidence_score: 0.85,
          categorised_by: 'G_VEC'
        };
      }

      // Template match found but no active user account mapped to this template
      console.debug(`⚠️ Global vector match found (template:${targetTemplateId}), but no active account mapped for this user.`);
    }

    return null;

  } catch (err) {
    console.error('❌ findVectorMatchWithEmbedding encountered an error:', err.message);
    return null;
  }
}

/**
 * Helper to calculate character-level overlap for catching typos.
 */
function stringOverlapScore(s1, s2) {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;
  return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
}

function editDistance(s1, s2) {
  s1 = s1.toLowerCase(); s2 = s2.toLowerCase();
  const costs = new Array();
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i == 0) costs[j] = j;
      else {
        if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) != s2.charAt(j - 1))
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

/**
 * resolveAccountFromTemplate
 * ─────────────────────────────────────────────────────────────────────────────
 * Maps a Template ID to a specific User Account ID.
 * If the user lacks an account for this template, it is AUTO-CREATED.
 */
async function resolveAccountFromTemplate(templateId, userId) {
  if (!templateId) return null;
  
  // 1. Check existing account for this template
  const { data: existing } = await supabase
    .from('accounts')
    .select('account_id, account_name')
    .eq('user_id', userId)
    .eq('template_id', templateId)
    .eq('is_active', true)
    .limit(1);

  if (existing && existing.length > 0) {
    const acc = existing[0];
    // Auto-heal stale 'Category N' names from old auto-creation runs
    if (acc.account_name && acc.account_name.startsWith('Category ')) {
      const fallbackNames = { 36: 'Food & Dining', 39: 'Mobile & Utilities', 97: 'Personal Care', 213: 'Groceries', 227: 'Travel & Transport', 578: 'Stationery' };
      const { data: tData } = await supabase.from('templates').select('template_name').eq('id', templateId).single();
      const correctName = (tData && tData.template_name) ? tData.template_name : (fallbackNames[templateId] || acc.account_name);
      if (correctName !== acc.account_name) {
        await supabase.from('accounts').update({ account_name: correctName }).eq('account_id', acc.account_id);
        console.info(`📝 Auto-healed account name: "${acc.account_name}" → "${correctName}"`);
      }
    }
    return acc.account_id;
  }

  // 2. Auto-Healing: Fetch template name and build the account box
  try {
    const { data: tData } = await supabase.from('templates').select('template_name').eq('id', templateId).single();
    
    // Comprehensive fallback names covering all known template IDs.
    // If a template is NOT listed here AND not in the templates table,
    // we return null rather than polluting the chart of accounts with "Category N".
    const fallbackNames = {
      14:  'Healthcare & Medical',
      30:  'Education',
      35:  'Housing & Rent',
      36:  'Food & Dining',
      37:  'Travel & Transport',
      38:  'Shopping & Clothing',
      39:  'Mobile & Utilities',
      40:  'Mobile & Utilities',
      41:  'Insurance',
      43:  'Investment & Savings',
      45:  'Entertainment & Leisure',
      52:  'Gifts & Donations',
      97:  'Personal Care',
      113: 'Advertising & Marketing',
      116: 'Subscriptions & Memberships',
      121: 'Bank Charges & Fees',
      156: 'Professional Fees',
      213: 'Groceries',
      227: 'Travel & Transport',
      262: 'Education Fees',
      265: 'Books & Media',
      295: 'Digital Wallets',
      296: 'Healthcare & Pharmacy',
      297: 'Hospitals & Clinics',
      298: 'Health Insurance',
      303: 'Other Taxes & Levies',
      310: 'Fuel',
      325: 'Miscellaneous',
      433: 'ATM & Cash Withdrawal',
      541: 'Investment & Savings',
      549: 'Loan & EMI',
      550: 'Credit Card Payment',
      578: 'Stationery & Office Supplies',
      580: 'Digital Services',
    };

    const accountName = (tData && tData.template_name)
      ? tData.template_name
      : fallbackNames[templateId];

    if (tData && tData.template_name) {
      console.debug(`📌 resolveAccountFromTemplate: Found name "${accountName}" in DB for template ${templateId}`);
    } else if (fallbackNames[templateId]) {
      console.debug(`📌 resolveAccountFromTemplate: Using fallback name "${accountName}" for template ${templateId}`);
    }

    // If we cannot determine a proper name, refuse to create the account.
    if (!accountName) {
      console.debug(`⚠️ resolveAccountFromTemplate: No name found for template ${templateId} — refusing to create "Category ${templateId}". Will fall to LLM.`);
      return null;
    }
    const { data: newAcc, error: createError } = await supabase
      .from('accounts')
      .insert({
        user_id: userId,
        account_name: accountName,
        template_id: templateId,
        account_type: 'EXPENSE',
        is_active: true,
        balance_nature: 'DEBIT' 
      })
      .select('account_id')
      .single();

    if (createError) {
      console.error(`❌ Failed to auto-create account box for template ${templateId}:`, createError.message);
      return null;
    }

    console.info(`✨ Auto-Discovery: Created new category box "${accountName}" for user.`);
    return newAcc.account_id;
  } catch (err) {
    console.error(`❌ resolveAccountFromTemplate error:`, err.message);
    return null;
  }
}

/**
 * sanitizeMerchantString
 * ─────────────────────────────────────────────────────────────────────────────
 * Strips UPI junk, numbers, and technical IDs to reveal the CORE merchant name.
 * Example: 'UPI-HOTELSAISHRADHA-GPAY-11256457128-TEA' -> 'HOTEL SAI SHRADHA TEA'
 */
function sanitizeMerchantString(str) {
  if (!str) return '';
  
  let cleanStr = str.trim();

  // 1. Aggressively extract user notes from UPI (HDFC Style)
  // In many bank formats, the note is appended at the very end after a hyphen,
  // and comes AFTER the VPA handle (which contains an '@').
  const atIndex = cleanStr.lastIndexOf('@');
  if (atIndex !== -1) {
    const lastHyphenIndex = cleanStr.lastIndexOf('-');
    // Ensure the hyphen comes after the handle to avoid catching hyphenated names
    if (lastHyphenIndex > atIndex) {
      const possibleNote = cleanStr.substring(lastHyphenIndex + 1).trim();
      // If it contains letters (not just bank numbers), it's highly likely a user note
      if (/[A-Za-z]/.test(possibleNote)) {
        // Fix: Preserve the prefix (merchant name) and append the note
        // Example: 'UPI-IRCTCAPP-RZP@PTYBL-OID123' -> 'IRCTCAPP OID123'
        cleanStr = cleanStr.substring(0, atIndex) + ' ' + possibleNote;
      }
    }
  }

  // Step 1.5: UPI slash format extraction
  if (str.startsWith('UPI/')) {
    const parts = str.split('/');
    // TJSB/SBI format: UPI/DR|CR/refnum/merchant/...
    if (parts[1]?.toUpperCase() === 'DR' || parts[1]?.toUpperCase() === 'CR') {
      cleanStr = parts[3]?.trim() || cleanStr;  // merchant is at index 3
    } else if (parts.length >= 4) {
      cleanStr = parts[2]?.trim() || cleanStr;  // ICICI: merchant at index 2
    }
  }
  
  // 2. Perform standard cleanup filters on remains or generic strings
  return cleanStr
    .replace(/^UPI[-/]/i, '')           // Remove UPI prefix with hyphen or slash
    .replace(/-GPAY-[0-9]+/i, '')       // Remove GPAY junk
    .replace(/@[a-zA-Z0-9.]+/i, '')     // Remove VPA handles (@okaxis, @ybl, etc.)
    .replace(/\bRZP\d*\b/gi, '')        // Strip RZP (Razorpay) IDs
    .replace(/\bOID\d*\b/gi, '')        // Strip OID (Order) IDs
    .replace(/PAYTMQR[A-Z0-9]*/gi, '')  // Strip Paytm QR junk
    .replace(/[0-9]+/g, ' ')            // Aggressively strip ALL numbers (Dates, small IDs)
    .replace(/[.!?]/g, ' ')             // Strip trailing dots and noise punctuation
    // Split common concatenated merchant names
    .replace(/(UBER|ZOMATO|SWIGGY|AMAZON|FLIPKART|RELIANCE|INDIANRAILWAY)(?=[A-Z])/gi, '$1 ')
    .replace(/([a-z])([A-Z])/g, '$1 $2') // Split CamelCase if any remains
    // Strip generic business suffixes that dilute vectors
    .replace(/\b(SYSTEMS|INDIA|CATER|STORES|SHOP|RETAIL|PVT|LTD|SERVICES|INFRA|CORP|UNIT|MAB|RZP|OID|GPAY|PAYTMQR)\b/gi, '')
    .replace(/[-_/]/g, ' ')             // Replace hyphens/underscores/slashes with spaces
    .replace(/\s+/g, ' ')               // Collapse whitespace
    .trim();
}

module.exports = {
  findVectorMatch,
  findVectorMatchWithEmbedding,
  sanitizeMerchantString
};
