// api/index.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());// api/index.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// ============================================
// 🔑 PayChangu Config
// ============================================
const PAYCHANGU_SECRET = process.env.PAYCHANGU_SECRET_KEY;
const PAYCHANGU_URL = 'https://api.paychangu.com';
const PLATFORM_FEE_PERCENT = 2;
const TRANSACTION_RETENTION_DAYS = 90;

// Operator reference IDs for Malawi
const OPERATORS = {
    AIRTEL_MWI: '20be6c20-adeb-4b5b-a7ba-0769820df4fb',
    TNM_MWI: 'b2a5c9e0-3b7c-4a1d-9e2f-8c4d5e6f7a8b' // update if you get TNM's actual ref_id
};

// ============================================
// 🔥 Firebase Admin Init
// ============================================
let db = null;
try {
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
    console.error('❌ Firebase Admin init failed:', err.message);
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
        retentionDays: TRANSACTION_RETENTION_DAYS,
        timestamp: new Date().toISOString()
    });
});

// ============================================
// 💸 Initiate Direct Charge (sends prompt to phone)
// ============================================
app.post('/api/payment', async (req, res) => {
    if (!PAYCHANGU_SECRET) {
        return res.status(500).json({ success: false, error: 'Not configured' });
    }

    const { phoneNumber, amount, provider, email, merchantUserId } = req.body;

    if (!phoneNumber || !amount) {
        return res.status(400).json({ success: false, error: 'Phone and amount required' });
    }

    // Normalize phone — PayChangu accepts +265XXXXXXXXX format
    let cleanPhone = String(phoneNumber).replace(/\s/g, '').replace('+', '');
    if (cleanPhone.startsWith('0')) {
        cleanPhone = '265' + cleanPhone.substring(1);
    } else if (!cleanPhone.startsWith('265')) {
        cleanPhone = '265' + cleanPhone;
    }
    cleanPhone = '+' + cleanPhone;

    // Calculate fees
    const amountNum = Number(amount);
    const platformFee = Math.round(amountNum * (PLATFORM_FEE_PERCENT / 100) * 100) / 100;
    const merchantReceives = amountNum - platformFee;

    // Unique charge ID for this transaction
    const chargeId = `PC-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    // Select operator
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

    console.log('=== Sending to PayChangu Direct Charge ===');
    console.log('Payload:', JSON.stringify(payload, null, 2));

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

        // Save pending transaction to Firestore
        if (db && merchantUserId && merchantUserId !== 'unknown') {
            const ttlDate = new Date();
            ttlDate.setDate(ttlDate.getDate() + TRANSACTION_RETENTION_DAYS);

            await db.collection('transactions').doc(chargeId).set({
                chargeId,
                txRef: chargeId,
                userId: merchantUserId,
                phoneNumber: cleanPhone,
                amount: amountNum,
                platformFee,
                merchantReceives,
                provider: provider || 'AIRTEL_MWI',
                status: 'PENDING',
                paychanguResponse: response.data,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                expireAt: admin.firestore.Timestamp.fromDate(ttlDate)
            });
        }

        res.json({
            success: true,
            chargeId,
            status: 'PENDING',
            message: `Payment prompt sent to ${phoneNumber}. Check your phone to authorize.`,
            data: response.data,
            platformFee,
            merchantReceives
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
// 🔍 Verify Direct Charge Payment
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

        const status = response.data?.data?.status || response.data?.status;

        // Update Firestore if status changed
        if (db) {
            const txnRef = db.collection('transactions').doc(chargeId);
            const txnDoc = await txnRef.get();

            if (txnDoc.exists) {
                const txnData = txnDoc.data();

                let finalStatus = 'PENDING';
                if (status === 'success' || status === 'successful') finalStatus = 'SUCCESS';
                else if (status === 'failed') finalStatus = 'FAILED';

                if (finalStatus !== txnData.status) {
                    await txnRef.update({
                        status: finalStatus,
                        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                        verifyResponse: response.data
                    });

                    // Credit merchant balance if success
                    if (finalStatus === 'SUCCESS' && txnData.userId !== 'unknown') {
                        await db.collection('businesses').doc(txnData.userId).update({
                            balance: admin.firestore.FieldValue.increment(txnData.merchantReceives || 0),
                            totalReceived: admin.firestore.FieldValue.increment(txnData.amount || 0),
                            totalFees: admin.firestore.FieldValue.increment(txnData.platformFee || 0)
                        });
                    }
                }
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

    const body = req.body || {};
    const chargeId = body.charge_id || body.data?.charge_id;
    const status = body.status || body.data?.status;

    // Respond quickly
    res.status(200).json({ received: true });

    if (!db || !chargeId) return;

    try {
        const txnRef = db.collection('transactions').doc(chargeId);
        const txnDoc = await txnRef.get();

        if (!txnDoc.exists) {
            console.log(`⚠️ Transaction ${chargeId} not found`);
            return;
        }

        const txnData = txnDoc.data();

        let finalStatus = 'PENDING';
        if (status === 'success' || status === 'successful') finalStatus = 'SUCCESS';
        else if (status === 'failed') finalStatus = 'FAILED';

        await txnRef.update({
            status: finalStatus,
            webhookData: body,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`✅ ${chargeId} → ${finalStatus}`);

        // Credit merchant balance if success
        if (finalStatus === 'SUCCESS' && txnData.userId !== 'unknown') {
            await db.collection('businesses').doc(txnData.userId).update({
                balance: admin.firestore.FieldValue.increment(txnData.merchantReceives || 0),
                totalReceived: admin.firestore.FieldValue.increment(txnData.amount || 0),
                totalFees: admin.firestore.FieldValue.increment(txnData.platformFee || 0)
            });
            console.log(`💰 Credited MWK ${txnData.merchantReceives} to ${txnData.userId}`);
        }
    } catch (err) {
        console.error('❌ Webhook error:', err.message);
    }
});

app.get('/api/webhook/paychangu', (req, res) => {
    res.json({
        status: 'webhook endpoint is ready',
        provider: 'PayChangu Direct Charge',
        firebase: db ? 'connected' : 'not configured',
        url: 'https://pay-kwacha.vercel.app/api/webhook/paychangu'
    });
});

module.exports = app;

// ============================================
// 🔑 Config
// ============================================
const PAYCHANGU_SECRET = process.env.PAYCHANGU_SECRET_KEY;
const PAYCHANGU_URL = 'https://api.paychangu.com';
const PLATFORM_FEE_PERCENT = 2;
const TRANSACTION_RETENTION_DAYS = 90; // 3 months

// ============================================
// 🔥 Firebase Admin Init (safe)
// ============================================
let db = null;
try {
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
        console.log('⚠️ FIREBASE_SERVICE_ACCOUNT not set — webhook writes disabled');
    }
} catch (err) {
    console.error('❌ Firebase Admin init failed:', err.message);
}

// ============================================
// 🏠 Health
// ============================================
app.get('/api', (req, res) => {
    res.json({
        name: 'PayKwacha API',
        status: 'running',
        provider: 'PayChangu',
        configured: !!PAYCHANGU_SECRET,
        firebase: db ? 'connected' : 'not configured',
        feePercent: PLATFORM_FEE_PERCENT,
        retentionDays: TRANSACTION_RETENTION_DAYS,
        timestamp: new Date().toISOString()
    });
});

// ============================================
// 💸 Initiate Payment
// ============================================
app.post('/api/payment', async (req, res) => {
    if (!PAYCHANGU_SECRET) {
        return res.status(500).json({ success: false, error: 'Not configured' });
    }

    const { phoneNumber, amount, provider, email, merchantUserId } = req.body;

    if (!phoneNumber || !amount) {
        return res.status(400).json({ success: false, error: 'Phone and amount required' });
    }

    let cleanPhone = String(phoneNumber).replace(/\s/g, '').replace('+', '');
    if (cleanPhone.startsWith('265')) cleanPhone = '0' + cleanPhone.substring(3);
    else if (!cleanPhone.startsWith('0')) cleanPhone = '0' + cleanPhone;

    const amountNum = Number(amount);
    const platformFee = Math.round(amountNum * (PLATFORM_FEE_PERCENT / 100) * 100) / 100;
    const merchantReceives = amountNum - platformFee;

    const txRef = `PAY-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const payload = {
        amount: String(amount),
        currency: 'MWK',
        email: email || 'customer@paykwacha.com',
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
            provider: provider || 'AIRTEL_MWI',
            merchantUserId: merchantUserId || 'unknown',
            platformFee: String(platformFee),
            merchantReceives: String(merchantReceives)
        }
    };

    try {
        const response = await axios.post(
            `${PAYCHANGU_URL}/payment`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${PAYCHANGU_SECRET}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        const checkoutUrl =
            response.data?.data?.checkout_url ||
            response.data?.checkout_url ||
            null;

        // Save pending transaction to Firestore
        if (db && merchantUserId && merchantUserId !== 'unknown') {
            const ttlDate = new Date();
            ttlDate.setDate(ttlDate.getDate() + TRANSACTION_RETENTION_DAYS);

            await db.collection('transactions').doc(txRef).set({
                txRef,
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
        }

        res.json({
            success: true,
            txRef,
            checkoutUrl,
            platformFee,
            merchantReceives,
            amount: amountNum,
            data: response.data
        });

    } catch (error) {
        const pcResponse = error.response?.data;
        res.status(500).json({
            success: false,
            error: pcResponse?.message || pcResponse?.error || error.message,
            raw: pcResponse
        });
    }
});

// ============================================
// 🔔 PayChangu Webhook (updates Firestore)
// ============================================
app.post('/api/webhook/paychangu', async (req, res) => {
    console.log('=== PayChangu Webhook ===');
    console.log(JSON.stringify(req.body, null, 2));

    const body = req.body || {};
    const txRef = body.tx_ref || body.data?.tx_ref;
    const status = body.status || body.data?.status;
    const amount = Number(body.amount || body.data?.amount || 0);

    // Respond quickly (PayChangu expects fast 200)
    res.status(200).json({ received: true });

    // Then process async
    if (!db || !txRef) {
        console.log('⚠️ Skipping Firestore update (no DB or txRef)');
        return;
    }

    try {
        const txnRef = db.collection('transactions').doc(txRef);
        const txnDoc = await txnRef.get();

        if (!txnDoc.exists) {
            console.log(`⚠️ Transaction ${txRef} not found in Firestore`);
            return;
        }

        const txnData = txnDoc.data();
        const userId = txnData.userId;
        const platformFee = txnData.platformFee || (amount * 0.02);
        const merchantReceives = txnData.merchantReceives || (amount - platformFee);

        // Map PayChangu status → our status
        let finalStatus = 'PENDING';
        if (status === 'success' || status === 'successful' || status === 'completed') {
            finalStatus = 'SUCCESS';
        } else if (status === 'failed' || status === 'cancelled') {
            finalStatus = 'FAILED';
        }

        // Update transaction
        await txnRef.update({
            status: finalStatus,
            webhookData: body,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`✅ Transaction ${txRef} → ${finalStatus}`);

        // If successful, credit the merchant's balance
        if (finalStatus === 'SUCCESS' && userId && userId !== 'unknown') {
            await db.collection('businesses').doc(userId).update({
                balance: admin.firestore.FieldValue.increment(merchantReceives),
                totalReceived: admin.firestore.FieldValue.increment(amount),
                totalFees: admin.firestore.FieldValue.increment(platformFee)
            });
            console.log(`💰 Credited MWK ${merchantReceives} to user ${userId}`);
        }
    } catch (err) {
        console.error('❌ Webhook processing error:', err.message);
    }
});

app.get('/api/webhook/paychangu', (req, res) => {
    res.json({
        status: 'webhook endpoint is ready',
        provider: 'PayChangu',
        firebase: db ? 'connected' : 'not configured',
        url: 'https://pay-kwacha.vercel.app/api/webhook/paychangu'
    });
});

// ============================================
// 🔍 Verify Payment
// ============================================
app.get('/api/payment-status/:txRef', async (req, res) => {
    if (!PAYCHANGU_SECRET) {
        return res.status(500).json({ success: false, error: 'Not configured' });
    }

    try {
        const response = await axios.get(
            `${PAYCHANGU_URL}/verify-payment/${req.params.txRef}`,
            {
                headers: { 'Authorization': `Bearer ${PAYCHANGU_SECRET}` }
            }
        );

        // Also update Firestore if status changed
        if (db) {
            const status = response.data?.data?.status || response.data?.status;
            if (status && status !== 'pending') {
                const txnRef = db.collection('transactions').doc(req.params.txRef);
                const txnDoc = await txnRef.get();
                if (txnDoc.exists && txnDoc.data().status === 'PENDING') {
                    let finalStatus = 'PENDING';
                    if (status === 'success' || status === 'successful') finalStatus = 'SUCCESS';
                    else if (status === 'failed') finalStatus = 'FAILED';

                    await txnRef.update({
                        status: finalStatus,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });

                    // Credit balance if success
                    if (finalStatus === 'SUCCESS') {
                        const txnData = txnDoc.data();
                        if (txnData.userId && txnData.userId !== 'unknown') {
                            await db.collection('businesses').doc(txnData.userId).update({
                                balance: admin.firestore.FieldValue.increment(txnData.merchantReceives || 0),
                                totalReceived: admin.firestore.FieldValue.increment(txnData.amount || 0),
                                totalFees: admin.firestore.FieldValue.increment(txnData.platformFee || 0)
                            });
                        }
                    }
                }
            }
        }

        res.json({ success: true, txRef: req.params.txRef, data: response.data });
    } catch (error) {
        res.status(500).json({
            success: false,
            txRef: req.params.txRef,
            error: error.response?.data || error.message
        });
    }
});

module.exports = app;
