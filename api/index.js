// api/index.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PAWAPAY_TOKEN = process.env.PAWAPAY_API_TOKEN;
const PAWAPAY_URL = 'https://api.sandbox.pawapay.io';

// ============================================
// 🏠 Health
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
    if (!PAWAPAY_TOKEN) return res.status(500).json({ success: false, error: 'Token not configured' });

    try {
        const check = await axios.get(`${PAWAPAY_URL}/active-conf`, {
            headers: { 'Authorization': `Bearer ${PAWAPAY_TOKEN}` }
        });
        res.json({ success: true, data: check.data });
    } catch (error) {
        res.status(500).json({
            success: false,
            status: error.response?.status,
            error: error.response?.data || error.message
        });
    }
});

// ============================================
// 💸 Payment (accepts API key)
// ============================================
app.post('/api/payment', async (req, res) => {
    if (!PAWAPAY_TOKEN) {
        return res.status(500).json({ success: false, error: 'Payment not configured' });
    }

    const { phoneNumber, amount, provider, apiKey } = req.body;

    if (!phoneNumber || !amount) {
        return res.status(400).json({ success: false, error: 'Phone and amount required' });
    }

    // Optional API key check (frontend sends it, backend can validate against Firestore later)
    // For now, only require it to start with PK_
    if (apiKey && !String(apiKey).startsWith('PK_')) {
        return res.status(401).json({ success: false, error: 'Invalid API key format' });
    }

    // Normalize phone
    let cleanPhone = String(phoneNumber).replace(/\s/g, '').replace('+', '');
    if (cleanPhone.startsWith('0')) cleanPhone = '265' + cleanPhone.substring(1);
    else if (!cleanPhone.startsWith('265')) cleanPhone = '265' + cleanPhone;

    const depositId = crypto.randomUUID();

    const payload = {
        depositId,
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
    };

    try {
        const response = await axios.post(
            `${PAWAPAY_URL}/deposits`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${PAWAPAY_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        res.json({
            success: true,
            depositId,
            data: response.data,
            message: `Payment request sent to ${phoneNumber}`
        });

    } catch (error) {
        const pawaResponse = error.response?.data;
        let errorMessage = 'Payment failed';

        if (pawaResponse) {
            if (typeof pawaResponse === 'string') errorMessage = pawaResponse;
            else if (pawaResponse.errorMessage) errorMessage = pawaResponse.errorMessage;
            else if (pawaResponse.message) errorMessage = pawaResponse.message;
            else if (pawaResponse.errorCode) errorMessage = `${pawaResponse.errorCode}: ${pawaResponse.errorMessage || ''}`;
            else if (pawaResponse.failures && Array.isArray(pawaResponse.failures)) {
                errorMessage = pawaResponse.failures.map(f => f.failureMessage || f.failureCode).join('; ');
            }
            else if (pawaResponse.error) errorMessage = typeof pawaResponse.error === 'string' ? pawaResponse.error : JSON.stringify(pawaResponse.error);
        } else if (error.message) errorMessage = error.message;

        res.status(500).json({
            success: false,
            error: errorMessage,
            pawaPayStatus: error.response?.status || null,
            pawaPayRaw: pawaResponse || null,
            requestSent: { depositId, phoneNumber: cleanPhone, amount, provider }
        });
    }
});

// ============================================
// 🔍 Payment status
// ============================================
app.get('/api/payment-status/:depositId', async (req, res) => {
    if (!PAWAPAY_TOKEN) return res.status(500).json({ success: false, error: 'Not configured' });

    try {
        const response = await axios.get(`${PAWAPAY_URL}/deposits/${req.params.depositId}`, {
            headers: { 'Authorization': `Bearer ${PAWAPAY_TOKEN}` }
        });
        res.json({ success: true, depositId: req.params.depositId, data: response.data });
    } catch (error) {
        res.status(500).json({
            success: false,
            depositId: req.params.depositId,
            error: error.response?.data || error.message
        });
    }
});

// ============================================
// 🔔 Webhook
// ============================================
app.post('/api/webhook/pawapay', async (req, res) => {
    console.log('=== pawaPay Webhook ===');
    console.log(JSON.stringify(req.body, null, 2));
    res.status(200).json({ received: true });
});

app.get('/api/webhook/pawapay', (req, res) => {
    res.json({
        status: 'webhook endpoint is ready',
        url: 'https://pay-kwacha.vercel.app/api/webhook/pawapay'
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