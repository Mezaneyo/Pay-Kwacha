const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// ============================================
// 🔥 Firebase Admin Init
// ============================================
// You'll need to add FIREBASE_SERVICE_ACCOUNT to Vercel env vars
// (Get it from Firebase Console → Project Settings → Service Accounts → Generate new private key)
let db;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        db = admin.firestore();
    }
} catch (err) {
    console.log('Firebase Admin not configured:', err.message);
}

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
        firebase: db ? 'connected' : 'not configured',
        timestamp: new Date().toISOString()
    });
});

// ============================================
// 🧪 pawaPay Test
// ============================================
app.get('/api/pawapay-test', async (req, res) => {
    if (!PAWAPAY_TOKEN) {
        return res.status(500).json({ error: 'PAWAPAY_API_TOKEN not set' });
    }

    const results = { timestamp: new Date().toISOString(), tests: {} };

    // Token check
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
    const { phoneNumber, amount, provider, userId, apiKey } = req.body;

    if (!phoneNumber || !amount) {
        return res.status(400).json({ error: 'Phone and amount required' });
    }

    // Normalize phone
    let cleanPhone = phoneNumber.replace(/\s/g, '').replace('+', '');
    if (cleanPhone.startsWith('0')) cleanPhone = '265' + cleanPhone.substring(1);
    else if (!cleanPhone.startsWith('265')) cleanPhone = '265' + cleanPhone;

    const depositId = `PAY-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

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
                customerMessage: 'PayKwacha Payment',
                metadata: [{ userId: userId || 'guest' }]
            },
            { headers: { 'Authorization': `Bearer ${PAWAPAY_TOKEN}` } }
        );

        // Save to Firestore
        if (db) {
            await db.collection('transactions').doc(depositId).set({
                depositId,
                userId: userId || 'guest',
                phoneNumber: cleanPhone,
                amount: Number(amount),
                currency: 'MWK',
                provider: provider || 'AIRTEL_MWI',
                status: 'PENDING',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                pawapayResponse: response.data
            });
        }

        res.json({ success: true, depositId, data: response.data });
    } catch (error) {
        console.error('Payment error:', error.response?.data || error.message);

        // Log failed attempt
        if (db) {
            await db.collection('transactions').doc(depositId).set({
                depositId,
                userId: userId || 'guest',
                phoneNumber: cleanPhone,
                amount: Number(amount),
                currency: 'MWK',
                status: 'FAILED',
                error: error.response?.data || error.message,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        res.status(500).json({
            success: false,
            error: error.response?.data || error.message
        });
    }
});

// ============================================
// 🔔 pawaPay Webhook
// ============================================
app.post('/api/webhook/pawapay', async (req, res) => {
    console.log('Webhook received:', JSON.stringify(req.body, null, 2));

    const { depositId, status } = req.body;

    if (db && depositId) {
        try {
            await db.collection('transactions').doc(depositId).update({
                status: status === 'COMPLETED' ? 'SUCCESS' : status,
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
                webhookData: req.body
            });
        } catch (err) {
            console.error('Webhook update error:', err.message);
        }
    }

    res.status(200).json({ received: true });
});

// ============================================
// 📧 Subscribe to Email List
// ============================================
app.post('/api/subscribe', async (req, res) => {
    const { email } = req.body;

    if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email required' });
    }

    if (!db) {
        return res.json({ success: true, message: 'Subscribed (demo mode)' });
    }

    try {
        await db.collection('subscribers').doc(email.toLowerCase()).set({
            email: email.toLowerCase(),
            subscribedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true, message: 'Successfully subscribed!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// 📊 Get User's Transactions
// ============================================
app.get('/api/transactions/:userId', async (req, res) => {
    const { userId } = req.params;

    if (!db) {
        return res.json({ transactions: [] });
    }

    try {
        const snapshot = await db
            .collection('transactions')
            .where('userId', '==', userId)
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();

        const transactions = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate?.() || null
        }));

        res.json({ transactions });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// 👤 Register Business (Create API Key)
// ============================================
app.post('/api/businesses/register', async (req, res) => {
    const { businessName, email, phone, userId } = req.body;

    const apiKey = `PK_${Date.now()}_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

    if (!db) {
        return res.json({ success: true, apiKey, message: 'Demo mode' });
    }

    try {
        await db.collection('businesses').doc(userId || email).set({
            businessName,
            email,
            phone,
            apiKey,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'active'
        });

        res.json({ success: true, apiKey });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = app;