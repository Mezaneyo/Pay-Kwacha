// api/index.js
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
    // --- Check token ---
    if (!PAWAPAY_TOKEN) {
        return res.status(500).json({
            success: false,
            error: 'Payment not configured. PAWAPAY_API_TOKEN missing.'
        });
    }

    // --- Extract request ---
    const { phoneNumber, amount, provider } = req.body;

    if (!phoneNumber || !amount) {
        return res.status(400).json({
            success: false,
            error: 'Phone number and amount are required'
        });
    }

    // --- Normalize phone to 265XXXXXXXXX ---
    let cleanPhone = String(phoneNumber).replace(/\s/g, '').replace('+', '');
    if (cleanPhone.startsWith('0')) {
        cleanPhone = '265' + cleanPhone.substring(1);
    } else if (!cleanPhone.startsWith('265')) {
        cleanPhone = '265' + cleanPhone;
    }

    // --- Generate deposit ID ---
    const depositId = `PAY-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

    // --- Build payload ---
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

    // --- Log request for debugging ---
    console.log('=== Sending to pawaPay ===');
    console.log(JSON.stringify(payload, null, 2));

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
        // ============================================
        // 🔍 Comprehensive Error Logging
        // ============================================
        console.error('=== pawaPay Error ===');
        console.error('HTTP Status:', error.response?.status);
        console.error('Response Data:', JSON.stringify(error.response?.data, null, 2));
        console.error('Error Message:', error.message);

        // ============================================
        // 🧠 Extract Meaningful Error Message
        // ============================================
        const pawaResponse = error.response?.data;
        let errorMessage = 'Payment failed. Please try again.';

        if (pawaResponse) {
            if (typeof pawaResponse === 'string') {
                errorMessage = pawaResponse;
            } else if (pawaResponse.errorMessage) {
                errorMessage = pawaResponse.errorMessage;
            } else if (pawaResponse.message) {
                errorMessage = pawaResponse.message;
            } else if (pawaResponse.errorCode) {
                errorMessage = `${pawaResponse.errorCode}: ${pawaResponse.errorMessage || 'Unknown error'}`;
            } else if (pawaResponse.failureReason) {
                errorMessage = pawaResponse.failureReason;
            } else if (Array.isArray(pawaResponse.failures)) {
                errorMessage = pawaResponse.failures
                    .map(f => f.failureMessage || f.failureCode || JSON.stringify(f))
                    .join('; ');
            } else if (pawaResponse.error !== undefined && pawaResponse.error !== null) {
                // Handle numeric codes like error: 1
                const errorCodes = {
                    1: 'Invalid request or account not configured in sandbox',
                    2: 'Insufficient funds or limit exceeded',
                    3: 'Invalid phone number or provider',
                    4: 'Transaction not permitted',
                    5: 'Duplicate transaction',
                    6: 'Transaction timed out',
                    7: 'Customer cancelled or declined'
                };
                errorMessage = `pawaPay error ${pawaResponse.error}: ${errorCodes[pawaResponse.error] || 'Unknown error'}`;
            } else {
                errorMessage = JSON.stringify(pawaResponse);
            }
        } else if (error.code === 'ECONNABORTED') {
            errorMessage = 'Request timed out. pawaPay did not respond in time.';
        } else if (error.message) {
            errorMessage = error.message;
        }

        // ============================================
        // 📤 Return Rich Error Info
        // ============================================
        res.status(500).json({
            success: false,
            error: errorMessage,
            pawaPayStatus: error.response?.status || null,
            pawaPayRaw: pawaResponse || null,
            requestSent: {
                depositId: depositId,
                phoneNumber: cleanPhone,
                amount: amount,
                provider: provider || 'AIRTEL_MWI',
                currency: 'MWK'
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
                headers: {
                    'Authorization': `Bearer ${PAWAPAY_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            depositId: depositId,
            status: response.data.status,
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
// 📝 Business Registration (placeholder)
// ============================================
app.post('/api/businesses/register', (req, res) => {
    const apiKey = `PK_${Date.now()}_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    res.json({
        success: true,
        apiKey: apiKey,
        message: 'Business registered (demo mode)'
    });
});

// ============================================
// 📧 Subscribe (placeholder — frontend handles Firebase)
// ============================================
app.post('/api/subscribe', (req, res) => {
    res.json({ success: true, message: 'Handled client-side' });
});

// ============================================
// 🌐 Fallback
// ============================================
app.use('/api/*', (req, res) => {
    res.status(404).json({
        success: false,
        error: `Route ${req.method} ${req.originalUrl} not found`
    });
});

// ============================================
// 🚀 Export
// ============================================
module.exports = app;
