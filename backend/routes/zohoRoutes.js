const express = require('express');
const router = express.Router();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const zohoMigrationService = require('../services/zohoMigrationService');
const zohoProcessorService = require('../services/zohoProcessorService');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL;

// GET /api/zoho/connect
router.get('/connect', (req, res) => {
    const userId = req.user?.id || req.query.userId;
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: ZOHO_CLIENT_ID,
        scope: 'ZohoBooks.fullaccess.all AaaServer.profile.READ',
        redirect_uri: ZOHO_REDIRECT_URI,
        access_type: 'offline',
        state: userId,
        prompt: 'consent',
    });

    res.redirect(`https://accounts.zoho.in/oauth/v2/auth?${params.toString()}`);
});

// GET /api/zoho/callback
// NOTE: This route is hit by Zoho's redirect — userId comes from the `state` param set during /connect.
// Auth middleware does NOT apply here since there is no session cookie at redirect time.
router.get('/callback', async (req, res) => {
    const { code, state: userId, 'accounts-server': accountsServer, location } = req.query;

    console.log('Zoho callback received:', { code: !!code, userId, accountsServer, location });

    if (!code || !userId) return res.redirect(`${FRONTEND_URL}/integrations?error=oauth_failed`);

    // Zoho sends back the correct accounts-server for the user's region — always use it
    const tokenDomain = accountsServer || 'https://accounts.zoho.in';
    const apiDomain = location ? `https://www.zohoapis.${location}` : 'https://www.zohoapis.in';

    console.log('Using tokenDomain:', tokenDomain);
    console.log('Using apiDomain:', apiDomain);

    try {
        const tokenResponse = await axios.post(`${tokenDomain}/oauth/v2/token`, null, {
            params: {
                code,
                client_id: ZOHO_CLIENT_ID,
                client_secret: ZOHO_CLIENT_SECRET,
                redirect_uri: ZOHO_REDIRECT_URI,
                grant_type: 'authorization_code',
            },
        });

        console.log('Token response:', tokenResponse.data);

        const { access_token, refresh_token, expires_in } = tokenResponse.data;

        if (!access_token) {
            throw new Error(`No access token received: ${JSON.stringify(tokenResponse.data)}`);
        }

        const orgResponse = await axios.get(`${apiDomain}/books/v3/organizations`, {
            headers: { Authorization: `Zoho-oauthtoken ${access_token}` },
        });

        const organization = orgResponse.data?.organizations?.[0];
        if (!organization) throw new Error('No Zoho organization found');

        // Fetch Zoho user profile to get their email
        let zohoUserEmail = null;
        try {
            const userInfoResponse = await axios.get(`${tokenDomain}/oauth/user/info`, {
                headers: { Authorization: `Zoho-oauthtoken ${access_token}` },
            });
            console.log('Zoho user info full response:', JSON.stringify(userInfoResponse.data));
            zohoUserEmail =
                userInfoResponse.data?.Email ||
                userInfoResponse.data?.email ||
                userInfoResponse.data?.ZAAID ||
                null;
            console.log('Zoho user email resolved to:', zohoUserEmail);
        } catch (userInfoErr) {
            console.warn('Could not fetch Zoho user info:', userInfoErr.response?.data || userInfoErr.message);
        }

        const expiresInValue = expires_in || tokenResponse.data.expires_in_sec || 3600;
        const tokenExpiresAt = new Date(Date.now() + expiresInValue * 1000).toISOString();

        // FIX #5: persist tokenDomain so zohoMigrationService can use it directly for token refresh
        const { error: dbError } = await supabase
            .from('zoho_integrations')
            .upsert(
                {
                    user_id: userId,
                    zoho_organization_id: organization.organization_id,
                    zoho_organization_name: organization.name,
                    zoho_user_email: zohoUserEmail,
                    access_token,
                    refresh_token,
                    token_expires_at: tokenExpiresAt,
                    // FIX #5: store token_domain so refresh never has to derive it
                    token_domain: tokenDomain,
                    api_domain: apiDomain,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'user_id' }
            );

        if (dbError) throw dbError;

        res.redirect(`${FRONTEND_URL}/settings?connected=true`);
    } catch (err) {
        console.error('Zoho OAuth callback error:', err.response?.data || err.message);
        res.redirect(`${FRONTEND_URL}/settings?connected=false`);
    }
});

// GET /api/zoho/status
router.get('/status', async (req, res) => {
    const userId = req.user?.id || req.query.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' });

    const { data, error } = await supabase
        .from('zoho_integrations')
        .select('zoho_organization_id, zoho_organization_name, zoho_user_email, created_at, migration_completed_at')
        .eq('user_id', userId)
        .single();

    if (error || !data) return res.json({ connected: false });

    res.json({
        connected: true,
        organizationId: data.zoho_organization_id,
        organizationName: data.zoho_organization_name,
        zohoUserEmail: data.zoho_user_email,
        connectedAt: data.created_at,
        migrationCompletedAt: data.migration_completed_at,
    });
});

// POST /api/zoho/migrate
// Step 1: Pull raw data from Zoho and stage it in zoho_imports table.
// COA goes directly into accounts table. Everything else is staged as raw JSON.
router.post('/migrate', async (req, res) => {
    const userId = req.user?.id || req.body.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' });

    try {
        const result = await zohoMigrationService.runMigration(userId, supabase);
        res.json({ success: true, summary: result });
    } catch (err) {
        console.error('Migration error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/zoho/process
// Step 2: Read staged zoho_imports and convert them into proper transactions rows.
// Safe to re-run — already-processed records are skipped.
router.post('/process', async (req, res) => {
    const userId = req.user?.id || req.body.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' });

    try {
        const result = await zohoProcessorService.runProcessor(userId, supabase);
        res.json({ success: true, summary: result });
    } catch (err) {
        console.error('Processor error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/zoho/sync
// Convenience endpoint: runs migrate + process in one shot.
// This is what the frontend Sync Data button should call.
router.post('/sync', async (req, res) => {
    const userId = req.user?.id || req.body.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' });

    try {
        console.log('[Sync] Starting full sync for user:', userId);

        console.log('[Sync] Phase 1 — Staging Zoho data');
        const migrationResult = await zohoMigrationService.runMigration(userId, supabase);

        console.log('[Sync] Phase 2 — Processing staged data into transactions');
        const processorResult = await zohoProcessorService.runProcessor(userId, supabase);

        res.json({
            success: true,
            summary: {
                ...migrationResult,
                ...processorResult,
            },
        });
    } catch (err) {
        console.error('Sync error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/zoho/disconnect
router.delete('/disconnect', async (req, res) => {
    const userId = req.user?.id || req.query.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' });

    const { error } = await supabase
        .from('zoho_integrations')
        .delete()
        .eq('user_id', userId);

    if (error) return res.status(500).json({ error: 'Failed to disconnect' });
    res.json({ success: true });
});

module.exports = router;