const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ============================================
// 🔑 Config
// ============================================
const PAWAPAY_TOKEN = process.env.PAWAPAY_API_TOKEN;
const PAWAPAY_URL = 'https://api.sandbox.pawapay.io';

// ============================================
// 🏠 Health Check
// ============================================
app.get('/api', (req, res) => {
    res.json({
        name: 'PayKwacha API',
        status: 'running',
        timestamp: new Date().toISOString()
    });
});

// ============================================
// 🧪 pawaPay Test
// ============================================
app.get('/api/pawapay-test', async (req, res) => {
    if (!PAWAPAY_TOKEN) {
        return res.status(500).json({
            error: 'PAWAPAY_API_TOKEN is not set in Vercel environment variables'
        });
    }

    const results = { timestamp: new Date().toISOString(), tests: {} };

    // Test 1: Token validity
    try {
        const tokenCheck = await axios.get(`${PAWAPAY_URL}/active-conf`, {
            headers: { 'Authorization': `Bearer ${PAWAPAY_TOKEN}` }
        });
        results.tests.tokenValid = { success: true, data: tokenCheck.data };
    } catch (error) {
        results.tests.tokenValid = {
            success: false,
            status: error.response?.status,
            error: error.response?.data || error.message
        };
    }

    // Test 2: Payment initiation
    const depositId = `TEST-${Date.now()}`;
    try {
        const payment = await axios.post(
            `${PAWAPAY_URL}/deposits`,
            {
                depositId: depositId,
                amount: '1000',
                currency: 'MWK',
                payer: {
                    type: 'MMO',
                    accountDetails: {
                        phoneNumber: '265888123456',
                        provider: 'AIRTEL_MWI'
                    }
                },
                customerMessage: 'PayKwacha Test'
            },
            { headers: { 'Authorization': `Bearer ${PAWAPAY_TOKEN}` } }
        );
        results.tests.payment = { success: true, depositId, response: payment.data };
    } catch (error) {
        results.tests.payment = {
            success: false,
            status: error.response?.status,
            error: error.response?.data || error.message
        };
    }

    res.json(results);
});

// ============================================
// 💸 Payment Endpoint
// ============================================
app.post('/api/payment', async (req, res) => {
    if (!PAWAPAY_TOKEN) {
        return res.status(500).json({
            success: false,
            error: 'Payment not configured. Contact support.'
        });
    }

    const { phoneNumber, amount, provider } = req.body;

    if (!phoneNumber || !amount) {
        return res.status(400).json({
            success: false,
            error: 'Phone number and amount are required'
        });
    }

    // Normalize phone
    let cleanPhone = phoneNumber.replace(/\s/g, '').replace('+', '');
    if (cleanPhone.startsWith('0')) cleanPhone = '265' + cleanPhone.substring(1);
    else if (!cleanPhone.startsWith('265')) cleanPhone = '265' + cleanPhone;

    const depositId = `PAY-${Date.now()}`;

    try {
        const response = await axios.post(
            `${PAWAPAY_URL}/deposits`,
            {
                depositId: depositId,
                amount: amount.toString(),
                currency: 'MWK',
                payer: {
                    type: 'MMO',
                    accountDetails: {
                        phoneNumber: cleanPhone,
                        provider: provider || 'AIRTEL_MWI'
                    }
                },
                customerMessage: 'PayKwacha Payment'
            },
            { headers: { 'Authorization': `Bearer ${PAWAPAY_TOKEN}` } }
        );

        res.json({ success: true, depositId, data: response.data });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.response?.data || error.message
        });
    }
});

// ============================================
// 📝 Business Registration (placeholder)
// ============================================
app.post('/api/businesses/register', (req, res) => {
    const apiKey = `PK_${Date.now()}_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    res.json({
        success: true,
        apiKey: apiKey,
        message: 'Business registered (demo mode — not saved yet)'
    });
});

// ============================================
// 🚀 Export
// ============================================
module.exports = app;
