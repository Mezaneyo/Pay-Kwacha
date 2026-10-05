// api/index.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ============================================
// 🔑 Config
// ============================================
const PAYCHANGU_URL = 'https://api.paychangu.com';
const PLATFORM_FEE_PERCENT = 2;
const TRANSACTION_RETENTION_DAYS = 90;

const OPERATORS = {
    AIRTEL_MWI: '20be6c20-adeb-4b5b-a7ba-0769820df4fb',
    TNM_MWI: '27494cb5-ba9e-437f-a114-4e7a7686bcca'
};

// ============================================
// 🔥 Firebase Admin — Safe init
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
        configured: true,
        firebase: db ? 'connected' : 'not configured',
        feePercent: PLATFORM_FEE_PERCENT,
        timestamp: new Date().toISOString()
    });
});

// ============================================
// 💸 Initiate Payment (uses merchant's own key)
// ============================================
app.post('/api/payment', async (req, res) => {
    if (!db) {
        return res.status(500).json({ success: false, error: 'Firebase not configured' });
    }

    const { phoneNumber, amount, provider, email, merchantUserId } = req.body;

    if (!phoneNumber || !amount || !merchantUserId) {
        return res.status(400).json({
            success: false,
            error: 'phoneNumber, amount, and merchantUserId are required'
        });
    }

    // Load merchant's PayChangu key
    let merchantKey;
    try {
        const merchantDoc = await db.collection('businesses').doc(merchantUserId).get();
        if (!merchantDoc.exists) {
            return res.status(404).json({ success: false, error: 'Merchant not found' });
        }
        merchantKey = merchantDoc.data().paychanguSecretKey;
        if (!merchantKey) {
            return res.status(400).json({
                success: false,
                error: 'Merchant has not connected their PayChangu account'
            });
        }
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Could not load merchant' });
    }

    // Normalize phone
    let cleanPhone = String(phoneNumber).replace(/\s/g, '').replace('+', '');
    if (cleanPhone.startsWith('265')) cleanPhone = cleanPhone.substring(3);
    if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.substring(1);

    if (cleanPhone.length !== 9) {
        return res.status(400).json({ success: false, error: `Invalid phone (${cleanPhone.length} digits)` });
    }

    const amountNum = Number(amount);
    const platformFee = Math.round(amountNum * (PLATFORM_FEE_PERCENT / 100) * 100) / 100;

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

    try {
        const response = await axios.post(
            `${PAYCHANGU_URL}/mobile-money/payments/initialize`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${merchantKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        // Save pending transaction
        const ttlDate = new Date();
        ttlDate.setDate(ttlDate.getDate() + TRANSACTION_RETENTION_DAYS);

        await db.collection('transactions').doc(chargeId).set({
            chargeId,
            userId: merchantUserId,
            phoneNumber: cleanPhone,
            amount: amountNum,
            platformFee,
            provider: provider || 'AIRTEL_MWI',
            status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expireAt: admin.firestore.Timestamp.fromDate(ttlDate)
        });

        // Track platform fee
        await db.collection('fee_ledger').add({
            merchantUserId,
            chargeId,
            amount: amountNum,
            platformFee,
            status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            success: true,
            chargeId,
            status: 'PENDING',
            message: `Prompt sent to ${cleanPhone}`,
            data: response.data
        });

    } catch (error) {
        const pcResponse = error.response?.data;
        res.status(500).json({
            success: false,
            error: pcResponse?.message || pcResponse?.error || error.message
        });
    }
});

// ============================================
// 🔍 Verify Payment
// ============================================
app.get('/api/payment-status/:chargeId', async (req, res) => {
    if (!db) {
        return res.status(500).json({ success: false, error: 'Firebase not configured' });
    }

    const { chargeId } = req.params;

    try {
        const txnDoc = await db.collection('transactions').doc(chargeId).get();
        if (!txnDoc.exists) {
            return res.status(404).json({ success: false, error: 'Transaction not found' });
        }

        const txnData = txnDoc.data();

        const merchantDoc = await db.collection('businesses').doc(txnData.userId).get();
        const merchantKey = merchantDoc.data()?.paychanguSecretKey;

        if (!merchantKey) {
            return res.status(400).json({ success: false, error: 'Merchant key missing' });
        }

        const response = await axios.get(
            `${PAYCHANGU_URL}/mobile-money/payments/${chargeId}/verify`,
            {
                headers: { 'Authorization': `Bearer ${merchantKey}` }
            }
        );

        const status = (response.data?.data?.status || response.data?.status || '').toLowerCase();

        if (status === 'success' || status === 'successful') {
            if (txnData.status !== 'SUCCESS') {
                await txnDoc.ref.update({
                    status: 'SUCCESS',
                    verifiedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Mark fee earned
                const feeSnapshot = await db.collection('fee_ledger')
                    .where('chargeId', '==', chargeId)
                    .limit(1)
                    .get();

                if (!feeSnapshot.empty) {
                    await feeSnapshot.docs[0].ref.update({
                        status: 'EARNED',
                        earnedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
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
// 💰 WITHDRAWAL — Send money via PayChangu Payout API
// ============================================
app.post('/api/withdraw', async (req, res) => {
    if (!db) {
        return res.status(500).json({ success: false, error: 'Firebase not configured' });
    }

    const { userId, phoneNumber, amount, provider } = req.body;

    if (!userId || !phoneNumber || !amount) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    try {
        // 1. Check merchant balance
        const businessDoc = await db.collection('businesses').doc(userId).get();
        if (!businessDoc.exists) {
            return res.status(404).json({ success: false, error: 'Merchant not found' });
        }

        const business = businessDoc.data();
        const currentBalance = business.balance || 0;
        const withdrawAmount = Number(amount);

        if (withdrawAmount > currentBalance) {
            return res.status(400).json({
                success: false,
                error: `Insufficient balance. Available: MWK ${currentBalance}`
            });
        }

        // 2. Get merchant's PayChangu key
        const merchantKey = business.paychanguSecretKey;
        if (!merchantKey) {
            return res.status(400).json({
                success: false,
                error: 'Merchant has not connected their PayChangu account'
            });
        }

        // 3. Normalize phone (9-digit format)
        let cleanPhone = String(phoneNumber).replace(/\s/g, '').replace('+', '');
        if (cleanPhone.startsWith('265')) cleanPhone = cleanPhone.substring(3);
        if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.substring(1);

        if (cleanPhone.length !== 9) {
            return res.status(400).json({ success: false, error: `Invalid phone (${cleanPhone.length} digits)` });
        }

        // 4. Unique charge ID
        const chargeId = `WD-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

        // 5. Call PayChangu Payout
        const operatorRef = provider === 'TNM_MWI'
            ? OPERATORS.TNM_MWI
            : OPERATORS.AIRTEL_MWI;

        const payoutResponse = await axios.post(
            `${PAYCHANGU_URL}/mobile-money/payouts/initialize`,
            {
                mobile_money_operator_ref_id: operatorRef,
                mobile: cleanPhone,
                amount: String(withdrawAmount),
                charge_id: chargeId
            },
            {
                headers: {
                    'Authorization': `Bearer ${merchantKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 30000
            }
        );

        // 6. Deduct from balance
        await db.collection('businesses').doc(userId).update({
            balance: admin.firestore.FieldValue.increment(-withdrawAmount)
        });

        // 7. Log withdrawal
        await db.collection('withdrawals').doc(chargeId).set({
            chargeId,
            userId,
            phoneNumber: cleanPhone,
            amount: withdrawAmount,
            provider: provider || 'AIRTEL_MWI',
            status: 'PROCESSING',
            paychanguResponse: payoutResponse.data,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            success: true,
            chargeId,
            message: `Withdrawal of MWK ${withdrawAmount} initiated to ${phoneNumber}`,
            data: payoutResponse.data
        });

    } catch (error) {
        console.error('Withdrawal error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.response?.data?.error || error.message
        });
    }
});

// ============================================
// 📜 List Merchant Withdrawals
// ============================================
app.get('/api/withdrawals/:userId', async (req, res) => {
    if (!db) {
        return res.status(500).json({ success: false, error: 'Firebase not configured' });
    }

    try {
        const snapshot = await db.collection('withdrawals')
            .where('userId', '==', req.params.userId)
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();

        const withdrawals = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate?.() || null
        }));

        res.json({ success: true, withdrawals });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 🔗 Connect Merchant PayChangu Key
// ============================================
app.post('/api/merchant/connect-key', async (req, res) => {
    const { userId, secretKey } = req.body;

    if (!userId || !secretKey) {
        return res.status(400).json({ success: false, error: 'userId and secretKey required' });
    }

    if (!secretKey.startsWith('sec-live-') && !secretKey.startsWith('sec-test-')) {
        return res.status(400).json({
            success: false,
            error: 'Key must start with sec-live- or sec-test-'
        });
    }

    if (!db) {
        return res.status(500).json({ success: false, error: 'Firebase not configured' });
    }

    try {
        // Validate key
        await axios.get(`${PAYCHANGU_URL}/mobile-money/operators`, {
            headers: { 'Authorization': `Bearer ${secretKey}` }
        });

        // Save it
        await db.collection('businesses').doc(userId).update({
            paychanguSecretKey: secretKey,
            paychanguConnectedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, message: 'Merchant connected to PayChangu' });

    } catch (error) {
        res.status(400).json({
            success: false,
            error: 'Invalid key or PayChangu rejected it',
            raw: error.response?.data
        });
    }
});

// ============================================
// 🔔 Webhook
// ============================================
app.post('/api/webhook/paychangu', async (req, res) => {
    console.log('=== Webhook ===');
    console.log(JSON.stringify(req.body, null, 2));
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
        if (status === 'success' || status === 'successful') finalStatus = 'SUCCESS';
        else if (status === 'failed' || status === 'cancelled') finalStatus = 'FAILED';

        if (txnData.status !== 'SUCCESS') {
            await txnRef.update({
                status: finalStatus,
                webhookData: body,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            if (finalStatus === 'SUCCESS') {
                const feeSnapshot = await db.collection('fee_ledger')
                    .where('chargeId', '==', chargeId)
                    .limit(1)
                    .get();

                if (!feeSnapshot.empty) {
                    await feeSnapshot.docs[0].ref.update({
                        status: 'EARNED',
                        earnedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }
            }
        }
    } catch (err) {
        console.error('Webhook error:', err.message);
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