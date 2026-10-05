// api/index.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ============================================
// 🔑 Config
// ============================================
const PAYCHANGU_SECRET = process.env.PAYCHANGU_SECRET_KEY;
const PAYCHANGU_URL = 'https://api.paychangu.com';
const PLATFORM_FEE_PERCENT = 2;
const TRANSACTION_RETENTION_DAYS = 90;

const OPERATORS = {
    AIRTEL_MWI: '20be6c20-adeb-4b5b-a7ba-0769820df4fb',
    TNM_MWI: '27494cb5-ba9e-437f-a114-4e7a7686bcca'
};

// ============================================
// 🔥 Firebase Admin — safe init
// ============================================
let db = null;
let admin = null;

try {
    admin = require('firebase-admin');
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        db = admin.firestore();
        console.log('✅ Firebase Admin initialized');
    } else {
        console.log('⚠️ FIREBASE_SERVICE_ACCOUNT not set');
    }
} catch (err) {
    console.log('⚠️ Firebase Admin unavailable:', err.message);
    admin = null;
    db = null;
}

// ============================================
// 🏠 Health
// ============================================
app.get('/api', (req, res) => {
    res.json({
        name: 'PayKwacha API',
        status: 'running',
        provider: 'PayChangu Direct Charge',
        configured: !!PAYCHANGU_SECRET,
        firebase: db ? 'connected' : 'not configured',
        feePercent: PLATFORM_FEE_PERCENT,
        timestamp: new Date().toISOString()
    });
});

// ============================================
// 💸 Initiate Direct Charge
// ============================================
app.post('/api/payment', async (req, res) => {
    if (!PAYCHANGU_SECRET) {
        return res.status(500).json({ success: false, error: 'Not configured' });
    }

    const { phoneNumber, amount, provider, email, merchantUserId } = req.body;

    if (!phoneNumber || !amount) {
        return res.status(400).json({ success: false, error: 'Phone and amount required' });
    }

    // Normalize phone to 9-digit format (no leading 0, no country code)
    let cleanPhone = String(phoneNumber).replace(/\s/g, '').replace('+', '');
    if (cleanPhone.startsWith('265')) cleanPhone = cleanPhone.substring(3);
    if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.substring(1);

    if (cleanPhone.length !== 9) {
        return res.status(400).json({
            success: false,
            error: `Invalid phone. Expected 9 digits, got ${cleanPhone.length}`
        });
    }

    const amountNum = Number(amount);
    const platformFee = Math.round(amountNum * (PLATFORM_FEE_PERCENT / 100) * 100) / 100;
    const merchantReceives = amountNum - platformFee;

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

    console.log('=== Sending to PayChangu ===');
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

        // Save pending transaction
        if (db && merchantUserId && merchantUserId !== 'unknown') {
            try {
                const ttlDate = new Date();
                ttlDate.setDate(ttlDate.getDate() + TRANSACTION_RETENTION_DAYS);

                await db.collection('transactions').doc(chargeId).set({
                    chargeId,
                    userId: merchantUserId,
                    phoneNumber: cleanPhone,
                    amount: amountNum,
                    platformFee,
                    merchantReceives,
                    provider: provider || 'AIRTEL_MWI',
                    status: 'PENDING',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    expireAt: admin.firestore.Timestamp.fromDate(ttlDate)
                });
                console.log('✅ Pending transaction saved');
            } catch (dbErr) {
                console.error('❌ Firestore write error:', dbErr.message);
            }
        }

        res.json({
            success: true,
            chargeId,
            status: 'PENDING',
            phoneUsed: cleanPhone,
            message: `Prompt sent to ${cleanPhone}`,
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
            raw: pcResponse
        });
    }
});

// ============================================
// 🔍 Verify Payment + Credit Balance
// ============================================
app.get('/api/payment-status/:chargeId', async (req, res) => {
    if (!PAYCHANGU_SECRET) {
        return res.status(500).json({ success: false, error: 'Not configured' });
    }

    const { chargeId } = req.params;

    try {
        const response = await axios.get(
            `${PAYCHANGU_URL}/mobile-money/payments/${chargeId}/verify`,
            {
                headers: {
                    'Authorization': `Bearer ${PAYCHANGU_SECRET}`,
                    'Accept': 'application/json'
                }
            }
        );

        const status = (response.data?.data?.status || response.data?.status || '').toLowerCase();

        // If successful and not yet credited, credit merchant balance
        if (db && (status === 'success' || status === 'successful' || status === 'completed')) {
            try {
                const txnRef = db.collection('transactions').doc(chargeId);
                const txnDoc = await txnRef.get();

                if (txnDoc.exists) {
                    const txnData = txnDoc.data();

                    if (txnData.status !== 'SUCCESS') {
                        await txnRef.update({
                            status: 'SUCCESS',
                            verifiedAt: admin.firestore.FieldValue.serverTimestamp()
                        });

                        if (txnData.userId && txnData.userId !== 'unknown') {
                            await db.collection('businesses').doc(txnData.userId).update({
                                balance: admin.firestore.FieldValue.increment(txnData.merchantReceives || 0),
                                totalReceived: admin.firestore.FieldValue.increment(txnData.amount || 0),
                                totalFees: admin.firestore.FieldValue.increment(txnData.platformFee || 0)
                            });
                            console.log(`💰 Credited MWK ${txnData.merchantReceives} to ${txnData.userId}`);
                        }
                    }
                }
            } catch (dbErr) {
                console.error('❌ Credit error:', dbErr.message);
            }
        }

        res.json({
            success: true,
            chargeId,
            status,
            data: response.data
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            chargeId,
            error: error.response?.data || error.message
        });
    }
});

// ============================================
// 🔔 PayChangu Webhook
// ============================================
app.post('/api/webhook/paychangu', async (req, res) => {
    console.log('=== PayChangu Webhook ===');
    console.log(JSON.stringify(req.body, null, 2));

    // Respond fast
    res.status(200).json({ received: true });

    const body = req.body || {};
    const chargeId = body.charge_id || body.data?.charge_id;
    const status = (body.status || body.data?.status || '').toLowerCase();

    if (!db || !chargeId) return;

    try {
        const txnRef = db.collection('transactions').doc(chargeId);
        const txnDoc = await txnRef.get();

        if (!txnDoc.exists) return;

        const txnData = txnDoc.data();

        let finalStatus = 'PENDING';
        if (status === 'success' || status === 'successful' || status === 'completed') finalStatus = 'SUCCESS';
        else if (status === 'failed' || status === 'cancelled') finalStatus = 'FAILED';

        if (txnData.status !== 'SUCCESS') {
            await txnRef.update({
                status: finalStatus,
                webhookData: body,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            if (finalStatus === 'SUCCESS' && txnData.userId && txnData.userId !== 'unknown') {
                await db.collection('businesses').doc(txnData.userId).update({
                    balance: admin.firestore.FieldValue.increment(txnData.merchantReceives || 0),
                    totalReceived: admin.firestore.FieldValue.increment(txnData.amount || 0),
                    totalFees: admin.firestore.FieldValue.increment(txnData.platformFee || 0)
                });
                console.log(`💰 Credited MWK ${txnData.merchantReceives} to ${txnData.userId}`);
            }
        }
    } catch (err) {
        console.error('❌ Webhook error:', err.message);
    }
});

app.get('/api/webhook/paychangu', (req, res) => {
    res.json({
        status: 'webhook endpoint is ready',
        firebase: db ? 'connected' : 'not configured',
        url: 'https://pay-kwacha.vercel.app/api/webhook/paychangu'
    });
});

module.exports = app;