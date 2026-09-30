// api/index.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ============================================
// 🔑 PayChangu Config
// ============================================
const PAYCHANGU_SECRET = process.env.PAYCHANGU_SECRET_KEY;
const PAYCHANGU_URL = 'https://api.paychangu.com';

// ============================================
// 🏠 Health Check
// ============================================
app.get('/api', (req, res) => {
    res.json({
        name: 'PayKwacha API',
        status: 'running',
        provider: 'PayChangu',
        configured: !!PAYCHANGU_SECRET,
        timestamp: new Date().toISOString()
    });
});

// ============================================
// 💸 Initiate Payment (Mobile Money)
// ============================================
app.post('/api/payment', async (req, res) => {
    if (!PAYCHANGU_SECRET) {
        return res.status(500).json({
            success: false,
            error: 'Payment not configured. PAYCHANGU_SECRET_KEY missing.'
        });
    }

    const { phoneNumber, amount, provider } = req.body;

    if (!phoneNumber || !amount) {
        return res.status(400).json({
            success: false,
            error: 'Phone number and amount are required'
        });
    }

    // Normalize phone to 0XXXXXXXXX (PayChangu expects local format)
    let cleanPhone = String(phoneNumber).replace(/\s/g, '').replace('+', '');
    if (cleanPhone.startsWith('265')) {
        cleanPhone = '0' + cleanPhone.substring(3);
    } else if (!cleanPhone.startsWith('0')) {
        cleanPhone = '0' + cleanPhone;
    }

    // Map provider to PayChangu format
    const mobileMoneyOperator = provider === 'TNM_MWI' ? 'tnm' : 'airtel';

    const txRef = `PAY-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const payload = {
        amount: String(amount),
        currency: 'MWK',
        email: 'customer@paykwacha.com',
        first_name: 'PayKwacha',
        last_name: 'Customer',
        callback_url: 'https://pay-kwacha.vercel.app/api/webhook/paychangu',
        return_url: 'https://pay-kwacha.vercel.app',
        tx_ref: txRef,
        customization: {
            title: 'PayKwacha Payment',
            description: 'Mobile money payment'
        },
        meta: {
            phone: cleanPhone,
            mobile_money_operator: mobileMoneyOperator
        }
    };

    console.log('=== Sending to PayChangu ===');
    console.log('Payload:', JSON.stringify(payload, null, 2));

    try {
        const response = await axios.post(
            `${PAYCHANGU_URL}/payment`,
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
            txRef: txRef,
            data: response.data,
            message: `Payment request sent to ${phoneNumber}`
        });

    } catch (error) {
        console.error('=== PayChangu Error ===');
        console.error('Status:', error.response?.status);
        console.error('Data:', JSON.stringify(error.response?.data, null, 2));

        const pcResponse = error.response?.data;
        let errorMessage = 'Payment failed';

        if (pcResponse) {
            if (typeof pcResponse === 'string') errorMessage = pcResponse;
            else if (pcResponse.message) errorMessage = pcResponse.message;
            else if (pcResponse.error) errorMessage = pcResponse.error;
            else errorMessage = JSON.stringify(pcResponse);
        } else if (error.message) {
            errorMessage = error.message;
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            paychanguStatus: error.response?.status || null,
            paychanguRaw: pcResponse || null,
            requestSent: {
                txRef: txRef,
                phoneNumber: cleanPhone,
                amount: amount,
                provider: mobileMoneyOperator
            }
        });
    }
});

// ============================================
// 🔍 Verify Payment Status
// ============================================
app.get('/api/payment-status/:txRef', async (req, res) => {
    if (!PAYCHANGU_SECRET) {
        return res.status(500).json({ success: false, error: 'Not configured' });
    }

    try {
        const response = await axios.get(
            `${PAYCHANGU_URL}/verify-payment/${req.params.txRef}`,
            {
                headers: {
                    'Authorization': `Bearer ${PAYCHANGU_SECRET}`,
                    'Accept': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            txRef: req.params.txRef,
            data: response.data
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            txRef: req.params.txRef,
            error: error.response?.data || error.message
        });
    }
});

// ============================================
// 🔔 PayChangu Webhook
// ============================================
app.post('/api/webhook/paychangu', async (req, res) => {
    console.log('=== PayChangu Webhook ===');
    console.log('Time:', new Date().toISOString());
    console.log('Body:', JSON.stringify(req.body, null, 2));

    const { tx_ref, status } = req.body || {};
    console.log(`Transaction ${tx_ref} → ${status}`);

    res.status(200).json({ received: true });
});

app.get('/api/webhook/paychangu', (req, res) => {
    res.json({
        status: 'webhook endpoint is ready',
        provider: 'PayChangu',
        url: 'https://pay-kwacha.vercel.app/api/webhook/paychangu'
    });
});

// ============================================
// 📝 Business Registration
// ============================================
app.post('/api/businesses/register', (req, res) => {
    const apiKey = `PK_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    res.json({ success: true, apiKey });
});

module.exports = app;
