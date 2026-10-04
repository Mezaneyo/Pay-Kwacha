// api/index.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PAYCHANGU_SECRET = process.env.PAYCHANGU_SECRET_KEY;
const PAYCHANGU_URL = 'https://api.paychangu.com';

const OPERATORS = {
    AIRTEL_MWI: '20be6c20-adeb-4b5b-a7ba-0769820df4fb',
    TNM_MWI: '27494cb5-ba9e-437f-a114-4e7a7686bcca'
};

// Health
app.get('/api', (req, res) => {
    res.json({
        name: 'PayKwacha API',
        status: 'running',
        provider: 'PayChangu Direct Charge',
        configured: !!PAYCHANGU_SECRET,
        timestamp: new Date().toISOString()
    });
});

// Direct Charge
app.post('/api/payment', async (req, res) => {
    if (!PAYCHANGU_SECRET) {
        return res.status(500).json({ success: false, error: 'Not configured' });
    }

    const { phoneNumber, amount, provider, email } = req.body;

    if (!phoneNumber || !amount) {
        return res.status(400).json({ success: false, error: 'Phone and amount required' });
    }

    // ✅ FIXED: 9-digit format without leading zero or country code
    let cleanPhone = String(phoneNumber).replace(/\s/g, '').replace('+', '');
    if (cleanPhone.startsWith('265')) {
        cleanPhone = cleanPhone.substring(3);
    }
    if (cleanPhone.startsWith('0')) {
        cleanPhone = cleanPhone.substring(1);
    }

    // Sanity check
    if (cleanPhone.length !== 9) {
        return res.status(400).json({
            success: false,
            error: `Invalid phone. Expected 9 digits, got ${cleanPhone.length}: "${cleanPhone}"`
        });
    }

    const chargeId = `PC-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const operatorRef = OPERATORS[provider] || OPERATORS.AIRTEL_MWI;

    const payload = {
        mobile_money_operator_ref_id: operatorRef,
        mobile: cleanPhone,
        amount: String(amount),
        charge_id: chargeId,
        email: email || 'customer@paykwacha.com',
        first_name: 'PayKwacha',
        last_name: 'Customer'
    };

    console.log('=== PayChangu Request ===');
    console.log(JSON.stringify(payload, null, 2));

    try {
        const response = await axios.post(
            `${PAYCHANGU_URL}/mobile-money/payments/initialize`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${PAYCHANGU_SECRET}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 30000
            }
        );

        console.log('=== PayChangu Success ===');
        console.log(JSON.stringify(response.data, null, 2));

        res.json({
            success: true,
            chargeId,
            status: 'PENDING',
            phoneUsed: cleanPhone,
            message: `Payment prompt sent to ${cleanPhone}`,
            data: response.data
        });

    } catch (error) {
        console.error('=== PayChangu Error ===');
        console.error('Status:', error.response?.status);
        console.error('Data:', JSON.stringify(error.response?.data, null, 2));

        const pcResponse = error.response?.data;
        res.status(500).json({
            success: false,
            error: pcResponse?.message || pcResponse?.error || error.message,
            raw: pcResponse,
            phoneUsed: cleanPhone
        });
    }
});

// Verify
app.get('/api/payment-status/:chargeId', async (req, res) => {
    if (!PAYCHANGU_SECRET) {
        return res.status(500).json({ success: false, error: 'Not configured' });
    }

    try {
        const response = await axios.get(
            `${PAYCHANGU_URL}/mobile-money/payments/${req.params.chargeId}/verify`,
            {
                headers: {
                    'Authorization': `Bearer ${PAYCHANGU_SECRET}`,
                    'Accept': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            chargeId: req.params.chargeId,
            status: response.data?.data?.status || response.data?.status,
            data: response.data
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            chargeId: req.params.chargeId,
            error: error.response?.data || error.message
        });
    }
});

// Webhook
app.post('/api/webhook/paychangu', async (req, res) => {
    console.log('=== PayChangu Webhook ===');
    console.log(JSON.stringify(req.body, null, 2));
    res.status(200).json({ received: true });
});

app.get('/api/webhook/paychangu', (req, res) => {
    res.json({
        status: 'webhook endpoint is ready',
        provider: 'PayChangu Direct Charge',
        url: 'https://pay-kwacha.vercel.app/api/webhook/paychangu'
    });
});

module.exports = app;