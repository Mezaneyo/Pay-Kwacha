// api/index.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

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
// 💸 Initiate Payment (FIXED for Malawi)
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

    // Normalize phone to 265XXXXXXXXX format
    let cleanPhone = String(phoneNumber).replace(/\s/g, '').replace('+', '');
    if (cleanPhone.startsWith('0')) {
        cleanPhone = '265' + cleanPhone.substring(1);
    } else if (!cleanPhone.startsWith('265')) {
        cleanPhone = '265' + cleanPhone;
    }

    // Generate UUID for depositId
    const depositId = crypto.randomUUID();

    // ============================================
    // 🔧 CORRECTED PAYLOAD FOR MALAWI
    // ============================================
    const payload = {
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
    };

    console.log('=== Sending to pawaPay ===');
    console.log('Payload:', JSON.stringify(payload, null, 2));

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

        console.log('=== pawaPay Success ===');
        console.log(JSON.stringify(response.data, null, 2));

        res.json({
            success: true,
            depositId: depositId,
            data: response.data,
            message: `Payment request sent to ${phoneNumber}`
        });

    } catch (error) {
        console.error('=== pawaPay Error ===');
        console.error('Status:', error.response?.status);
        console.error('Data:', JSON.stringify(error.response?.data, null, 2));

        const pawaResponse = error.response?.data;
        let errorMessage = 'Payment failed';

        if (pawaResponse) {
            if (typeof pawaResponse === 'string') {
                errorMessage = pawaResponse;
            } else if (pawaResponse.errorMessage) {
                errorMessage = pawaResponse.errorMessage;
            } else if (pawaResponse.message) {
                errorMessage = pawaResponse.message;
            } else if (pawaResponse.errorCode) {
                errorMessage = `${pawaResponse.errorCode}: ${pawaResponse.errorMessage || ''}`;
            } else if (pawaResponse.failures && Array.isArray(pawaResponse.failures)) {
                errorMessage = pawaResponse.failures
                    .map(f => `${f.field || 'error'}: ${f.failureMessage || f.failureCode}`)
                    .join('; ');
            } else if (pawaResponse.error) {
                errorMessage = typeof pawaResponse.error === 'string'
                    ? pawaResponse.error
                    : JSON.stringify(pawaResponse.error);
            } else {
                errorMessage = JSON.stringify(pawaResponse);
            }
        } else if (error.message) {
            errorMessage = error.message;
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            pawaPayStatus: error.response?.status || null,
            pawaPayRaw: pawaResponse || null,
            requestSent: {
                depositId: depositId,
                phoneNumber: cleanPhone,
                amount: amount,
                provider: provider || 'AIRTEL_MWI'
            }
        });
    }
});

// ============================================
// 🔍 Check Deposit Status
// ============================================
app.get('/api/payment-status/:depositId', async (req, res) => {
    if (!PAWAPAY_TOKEN) {
        return res.status(500).json({ success: false, error: 'Not configured' });
    }

    const { depositId } = req.params;

    try {
        const response = await axios.get(
            `${PAWAPAY_URL}/deposits/${depositId}`,
            {
                headers: { 'Authorization': `Bearer ${PAWAPAY_TOKEN}` }
            }
        );

        res.json({
            success: true,
            depositId: depositId,
            data: response.data
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            depositId: depositId,
            error: error.response?.data || error.message
        });
    }
});

// ============================================
// 📝 Business Registration
// ============================================
app.post('/api/businesses/register', (req, res) => {
    const apiKey = `PK_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    res.json({ success: true, apiKey: apiKey });
});

// ============================================
// 📧 Subscribe
// ============================================
app.post('/api/subscribe', (req, res) => {
    res.json({ success: true, message: 'Handled client-side' });
});

// ============================================
// 🚀 Export
// ============================================
module.exports = app;
