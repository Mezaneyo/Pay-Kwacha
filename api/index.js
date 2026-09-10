// api/index.js
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ============================================
// 🔑 pawaPay Config
// ============================================
const PAWAPAY_TOKEN = process.env.PAWAPAY_API_TOKEN || 'eyJraWQiOiIxIiwiYWxnIjoiRVMyNTYifQ.eyJ0dCI6IkFBVCIsInN1YiI6IjI4NzU2IiwibWF2IjoiMSIsImV4cCI6MjEwNDY5NDE1OSwiaWF0IjoxNzg5MDc0OTU5LCJwbSI6IkRBRixQQUYiLCJqdGkiOiI5YjdmOTZmYS1lZjhiLTQ3MTYtOWE5ZS0zZjdhOGRlYjkwNTAifQ.8sfOu1IN0qNI8eXYMYZMui0oum2BZ82BbaSoIyu11MSVmMSbb6So56hNuX1zeC-vuhxUUSbCKsuHOp3UbL3WYA';
const PAWAPAY_URL = 'https://api.sandbox.pawapay.io';

// ============================================
// 🧪 TEST ENDPOINT - Visit this to test
// ============================================
app.get('/api/pawapay-test', async (req, res) => {
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
// 💸 Real payment endpoint (called by your HTML)
// ============================================
app.post('/api/payment', async (req, res) => {
    const { phoneNumber, amount, provider } = req.body;

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
// 🏠 Home route
// ============================================
app.get('/api', (req, res) => {
    res.json({ name: 'PayKwacha API', status: 'running' });
});

module.exports = app;
