// api/index.js
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ============================================
// 🔑 pawaPay Config
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
        pawapayConfigured: !!PAWAPAY_TOKEN,
        timestamp: new Date().toISOString()
    });
});

// ============================================
// 🧪 pawaPay Test
// ============================================
app.get('/api/pawapay-test', async (req, res) => {
    if (!PAWAPAY_TOKEN) {
        return res.status(500).json({
            success: false,
            error: 'PAWAPAY_API_TOKEN not configured'
        });
    }

    const results = { timestamp: new Date().toISOString(), tests: {} };

    try {
        const check = await axios.get(`${PAWAPAY_URL}/active-conf`, {
            headers: { 'Authorization': `Bearer ${PAWAPAY_TOKEN}` }
        });
        results.tests.tokenValid = { success: true, data: check.data };
    } catch (error) {
        results.tests.tokenValid = {
            success: false,
            status: error.response?.status,
            error: error.response?.data || error.message
        };
    }

    res.json(results);
});

// ============================================
// 💸 Initiate Payment
// ============================================
app.post('/api/payment', async (req, res) => {
    if (!PAWAPAY_TOKEN) {
        return res.status(500).json({
            success: false,
            error: 'Payment not configured'
        });
    }

    const { phoneNumber, amount, provider } = req.body;

    if (!phoneNumber || !amount) {
        return res.status(400).json({
            success: false,
            error: 'Phone number and amount are required'
        });
    }

    let cleanPhone = String(phoneNumber).replace(/\s/g, '').replace('+', '');
    if (cleanPhone.startsWith('0')) cleanPhone = '265' + cleanPhone.substring(1);
    else if (!cleanPhone.startsWith('265')) cleanPhone = '265' + cleanPhone;

    const depositId = `PAY-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

    try {
        const response = await axios.post(
            `${PAWAPAY_URL}/deposits`,
            {
                depositId: depositId,
                amount: String(amount),
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
            {
                headers: {
                    'Authorization': `Bearer ${PAWAPAY_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            depositId: depositId,
            data: response.data,
            message: `Payment request sent to ${phoneNumber}`
        });
    } catch (error) {
        console.error('Payment error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message ||
                   error.response?.data?.errorCode ||
                   error.message ||
                   'Payment failed'
        });
    }
});

// ============================================
// 📝 Business Registration
// ============================================
app.post('/api/businesses/register', (req, res) => {
    const apiKey = `PK_${Date.now()}_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    res.json({ success: true, apiKey: apiKey });
});

// ============================================
// 🚀 Export
// ============================================
module.exports = app;