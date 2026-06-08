const axios = require('axios');

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;

const ZOHO_TO_LEDGER_TYPE = {
    cash: { type: 'ASSET', nature: 'DEBIT' },
    bank: { type: 'ASSET', nature: 'DEBIT' },
    other_current_asset: { type: 'ASSET', nature: 'DEBIT' },
    fixed_asset: { type: 'ASSET', nature: 'DEBIT' },
    other_asset: { type: 'ASSET', nature: 'DEBIT' },
    accounts_receivable: { type: 'ASSET', nature: 'DEBIT' },
    stock: { type: 'ASSET', nature: 'DEBIT' },
    credit_card: { type: 'LIABILITY', nature: 'CREDIT' },
    accounts_payable: { type: 'LIABILITY', nature: 'CREDIT' },
    other_current_liability: { type: 'LIABILITY', nature: 'CREDIT' },
    long_term_liability: { type: 'LIABILITY', nature: 'CREDIT' },
    other_liability: { type: 'LIABILITY', nature: 'CREDIT' },
    equity: { type: 'EQUITY', nature: 'CREDIT' },
    retained_earnings: { type: 'EQUITY', nature: 'CREDIT' },
    owners_equity: { type: 'EQUITY', nature: 'CREDIT' },
    income: { type: 'INCOME', nature: 'CREDIT' },
    other_income: { type: 'INCOME', nature: 'CREDIT' },
    expense: { type: 'EXPENSE', nature: 'DEBIT' },
    cost_of_goods_sold: { type: 'EXPENSE', nature: 'DEBIT' },
    other_expense: { type: 'EXPENSE', nature: 'DEBIT' },
};

function mapAccountType(zohoType) {
    const normalized = zohoType?.toLowerCase().replace(/ /g, '_');
    return ZOHO_TO_LEDGER_TYPE[normalized] || { type: 'ASSET', nature: 'DEBIT' };
}

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

// Always refreshes token if close to expiry — called at start of every step
async function getValidAccessToken(integration, supabase) {
    const now = new Date();
    const expiresAt = new Date(integration.token_expires_at);

    if (isNaN(expiresAt) || expiresAt - now < 5 * 60 * 1000) {
        const tokenDomain =
            integration.token_domain ||
            (integration.api_domain
                ? integration.api_domain.replace('www.zohoapis', 'accounts.zoho')
                : 'https://accounts.zoho.com');

        const response = await axios.post(`${tokenDomain}/oauth/v2/token`, null, {
            params: {
                refresh_token: integration.refresh_token,
                client_id: ZOHO_CLIENT_ID,
                client_secret: ZOHO_CLIENT_SECRET,
                grant_type: 'refresh_token',
            },
        });

        if (response.data.error) {
            throw new Error(`Zoho token refresh error: ${response.data.error}`);
        }

        const access_token = response.data.access_token;
        const expires_in = response.data.expires_in || response.data.expires_in_sec || 3600;

        if (!access_token) {
            throw new Error(`Failed to refresh token: ${JSON.stringify(response.data)}`);
        }

        const newExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

        await supabase
            .from('zoho_integrations')
            .update({
                access_token,
                token_expires_at: newExpiresAt,
                updated_at: new Date().toISOString(),
            })
            .eq('user_id', integration.user_id);

        // Update in-memory so subsequent steps in same run use fresh token
        integration.access_token = access_token;
        integration.token_expires_at = newExpiresAt;

        return access_token;
    }

    return integration.access_token;
}

// ─── STEP 1: Chart of Accounts → accounts table (already correct schema) ───
async function migrateChartOfAccounts(integration, supabase) {
    const accessToken = await getValidAccessToken(integration, supabase);
    const apiDomain = integration.api_domain || 'https://www.zohoapis.com';
    const orgId = integration.zoho_organization_id;

    let allAccounts = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const response = await axios.get(`${apiDomain}/books/v3/chartofaccounts`, {
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
            params: { organization_id: orgId, page, per_page: 200 },
        });

        const accounts = response.data?.chartofaccounts || [];
        allAccounts = [...allAccounts, ...accounts];
        hasMore = response.data?.page_context?.has_more_page || false;
        page++;
    }

    const accountRecords = allAccounts.map((acc) => {
        const { type, nature } = mapAccountType(acc.account_type);
        return {
            user_id: integration.user_id,
            account_name: acc.account_name,
            account_type: type,
            balance_nature: nature,
            external_id: `zoho_${acc.account_id}`,
            is_active: !acc.is_inactive,
            source: 'zoho_import',
        };
    });

    // Also stage raw COA payloads for reference
    const stagingRecords = allAccounts.map((acc) => ({
        user_id: integration.user_id,
        zoho_org_id: orgId,
        zoho_raw_type: 'account',
        zoho_id: acc.account_id,
        raw_payload: acc,
        processed: true, // COA is processed immediately into accounts table
        processed_at: new Date().toISOString(),
    }));

    // Upsert into accounts table
    const { data: insertedAccounts, error } = await supabase
        .from('accounts')
        .upsert(accountRecords, {
            onConflict: 'user_id,external_id',
            ignoreDuplicates: false,
        })
        .select('account_id, external_id');

    if (error) throw new Error(`COA insert failed: ${error.message}`);

    // Stage COA in zoho_imports (best effort)
    for (const chunk of chunkArray(stagingRecords, 100)) {
        await supabase
            .from('zoho_imports')
            .upsert(chunk, { onConflict: 'user_id,zoho_raw_type,zoho_id' });
    }

    const accountIdMap = {};
    for (const acc of insertedAccounts) {
        accountIdMap[acc.external_id] = acc.account_id;
    }

    return { count: insertedAccounts.length, accountIdMap };
}

// ─── STEP 2: Journal Entries → zoho_imports staging ─────────────────────────
async function migrateJournals(integration, supabase) {
    const accessToken = await getValidAccessToken(integration, supabase);
    const apiDomain = integration.api_domain || 'https://www.zohoapis.com';
    const orgId = integration.zoho_organization_id;

    // Step 1: get list of journal IDs
    let allJournalIds = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const response = await axios.get(`${apiDomain}/books/v3/journals`, {
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
            params: { organization_id: orgId, page, per_page: 200 },
        });
        const journals = response.data?.journals || [];
        allJournalIds = [...allJournalIds, ...journals.map(j => j.journal_id)];
        hasMore = response.data?.page_context?.has_more_page || false;
        page++;
    }

    // Step 2: fetch each journal individually to get line_items
    const fullJournals = [];
    for (const journalId of allJournalIds) {
        const detail = await axios.get(`${apiDomain}/books/v3/journals/${journalId}`, {
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
            params: { organization_id: orgId },
        });
        const journal = detail.data?.journal;
        if (journal) fullJournals.push(journal);
    }

    // Step 3: stage with full payload including line_items
    const records = fullJournals.map((journal) => ({
        user_id: integration.user_id,
        zoho_org_id: orgId,
        zoho_raw_type: 'journal',
        zoho_id: journal.journal_id,
        raw_payload: journal,
        processed: false,
    }));

    let count = 0;
    for (const chunk of chunkArray(records, 100)) {
        const { error } = await supabase
            .from('zoho_imports')
            .upsert(chunk, { onConflict: 'user_id,zoho_raw_type,zoho_id' });
        if (!error) count += chunk.length;
        else console.warn(`Journal staging error: ${error.message}`);
    }

    console.log(`[Zoho] Staged ${count} journals with full line items`);
    return { count };
}

// ─── STEP 3: Invoices → zoho_imports staging ────────────────────────────────
async function migrateInvoices(integration, supabase) {
    const accessToken = await getValidAccessToken(integration, supabase);
    const apiDomain = integration.api_domain || 'https://www.zohoapis.com';
    const orgId = integration.zoho_organization_id;

    let allInvoices = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const response = await axios.get(`${apiDomain}/books/v3/invoices`, {
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
            params: { organization_id: orgId, page, per_page: 200 },
        });

        const invoices = response.data?.invoices || [];
        allInvoices = [...allInvoices, ...invoices];
        hasMore = response.data?.page_context?.has_more_page || false;
        page++;
    }

    const records = allInvoices.map((invoice) => ({
        user_id: integration.user_id,
        zoho_org_id: orgId,
        zoho_raw_type: 'invoice',
        zoho_id: invoice.invoice_id,
        raw_payload: invoice,
        processed: false,
    }));

    let count = 0;
    for (const chunk of chunkArray(records, 100)) {
        const { error } = await supabase
            .from('zoho_imports')
            .upsert(chunk, { onConflict: 'user_id,zoho_raw_type,zoho_id' });
        if (!error) count += chunk.length;
        else console.warn(`Invoice staging error: ${error.message}`);
    }

    console.log(`[Zoho] Staged ${count} invoices`);
    return { count };
}

// ─── STEP 4: Bills → zoho_imports staging ───────────────────────────────────
async function migrateBills(integration, supabase) {
    const accessToken = await getValidAccessToken(integration, supabase);
    const apiDomain = integration.api_domain || 'https://www.zohoapis.com';
    const orgId = integration.zoho_organization_id;

    let allBills = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const response = await axios.get(`${apiDomain}/books/v3/bills`, {
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
            params: { organization_id: orgId, page, per_page: 200 },
        });

        const bills = response.data?.bills || [];
        allBills = [...allBills, ...bills];
        hasMore = response.data?.page_context?.has_more_page || false;
        page++;
    }

    const records = allBills.map((bill) => ({
        user_id: integration.user_id,
        zoho_org_id: orgId,
        zoho_raw_type: 'bill',
        zoho_id: bill.bill_id,
        raw_payload: bill,
        processed: false,
    }));

    let count = 0;
    for (const chunk of chunkArray(records, 100)) {
        const { error } = await supabase
            .from('zoho_imports')
            .upsert(chunk, { onConflict: 'user_id,zoho_raw_type,zoho_id' });
        if (!error) count += chunk.length;
        else console.warn(`Bill staging error: ${error.message}`);
    }

    console.log(`[Zoho] Staged ${count} bills`);
    return { count };
}

// ─── STEP 5: Bank Transactions → zoho_imports staging ───────────────────────
async function migrateBankTransactions(integration, supabase) {
    const accessToken = await getValidAccessToken(integration, supabase);
    const apiDomain = integration.api_domain || 'https://www.zohoapis.com';
    const orgId = integration.zoho_organization_id;

    const bankResponse = await axios.get(`${apiDomain}/books/v3/bankaccounts`, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        params: { organization_id: orgId },
    });

    const bankAccounts = bankResponse.data?.bankaccounts || [];
    let allTxnRecords = [];

    for (const bankAccount of bankAccounts) {
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const response = await axios.get(`${apiDomain}/books/v3/banktransactions`, {
                headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
                params: {
                    organization_id: orgId,
                    account_id: bankAccount.account_id,
                    page,
                    per_page: 200,
                },
            });

            const txns = response.data?.banktransactions || [];
            for (const txn of txns) {
                allTxnRecords.push({
                    user_id: integration.user_id,
                    zoho_org_id: orgId,
                    zoho_raw_type: 'bank_txn',
                    zoho_id: txn.transaction_id,
                    raw_payload: { ...txn, bank_account_id: bankAccount.account_id },
                    processed: false,
                });
            }

            hasMore = response.data?.page_context?.has_more_page || false;
            page++;
        }
    }

    let totalCount = 0;
    for (const chunk of chunkArray(allTxnRecords, 100)) {
        const { error } = await supabase
            .from('zoho_imports')
            .upsert(chunk, { onConflict: 'user_id,zoho_raw_type,zoho_id' });
        if (!error) totalCount += chunk.length;
        else console.warn(`Bank txn staging error: ${error.message}`);
    }

    console.log(`[Zoho] Staged ${totalCount} bank transactions`);
    return { count: totalCount };
}

// ─── Main migration runner ───────────────────────────────────────────────────
async function runMigration(userId, supabase) {
    const { data: integration, error: integrationError } = await supabase
        .from('zoho_integrations')
        .select('*')
        .eq('user_id', userId)
        .single();

    if (integrationError || !integration) {
        throw new Error('No Zoho integration found. Please connect your Zoho Books account first.');
    }

    console.log('STEP 1 - Migrating COA');
    const { count: accountCount, accountIdMap } =
        await migrateChartOfAccounts(integration, supabase);

    console.log('STEP 2 - Staging Journal Entries');
    const { count: journalCount } =
        await migrateJournals(integration, supabase);

    console.log('STEP 3 - Staging Invoices');
    const { count: invoiceCount } =
        await migrateInvoices(integration, supabase);

    console.log('STEP 4 - Staging Bills');
    const { count: billCount } =
        await migrateBills(integration, supabase);

    console.log('STEP 5 - Staging Bank Transactions');
    const { count: bankTxnCount } =
        await migrateBankTransactions(integration, supabase);

    await supabase
        .from('zoho_integrations')
        .update({ migration_completed_at: new Date().toISOString() })
        .eq('user_id', userId);

    return {
        accountsImported: accountCount,
        journalsStaged: journalCount,
        invoicesStaged: invoiceCount,
        billsStaged: billCount,
        bankTransactionsStaged: bankTxnCount,
    };
}

module.exports = { runMigration, mapAccountType };