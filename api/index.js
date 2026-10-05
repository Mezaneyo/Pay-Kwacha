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
// 🔥 Firebase Admin
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
    }
} catch (err) {
    console.log('⚠️ Firebase Admin unavailable:', err.message);
    admin = null;
    db = null;
}

// ============================================
// 🔑 Merchant lookup by API key
// ============================================
async function getMerchantByApiKey(apiKey) {
    if (!db || !apiKey) return null;
    try {
        const snapshot = await db.collection('businesses')
            .where('apiKey', '==', apiKey)
            .limit(1)
            .get();
        if (snapshot.empty) return null;
        const doc = snapshot.docs[0];
        return { id: doc.id, ...doc.data() };
    } catch (err) {
        console.error('API key lookup error:', err.message);
        return null;
    }
}

// ============================================
// 🏠 Health
// ============================================
app.get('/api', (req, res) => {
    res.json({
        name: 'PayKwacha API',
        status: 'running',
        provider: 'PayChangu Direct Charge + Payouts',
        auth: 'api-key',
        firebase: db ? 'connected' : 'not configured',
        timestamp: new Date().toISOString()
    });
});

// ============================================
// 💸 Initiate Payment
// ============================================
app.post('/api/payment', async (req, res) => {
    if (!db) {
        return res.status(500).json({ success: false, error: 'Firebase not configured' });
    }

    const { apiKey, phoneNumber, amount, provider, email } = req.body;

    if (!apiKey) {
        return res.status(401).json({
            success: false,
            error: 'Missing API key'
        });
    }

    const merchant = await getMerchantByApiKey(apiKey);
    if (!merchant) {
        return res.status(401).json({
            success: false,
            error: 'Invalid API key'
        });
    }

    if (!phoneNumber || !amount) {
        return res.status(400).json({
            success: false,
            error: 'phoneNumber and amount are required'
        });
    }

    const PLATFORM_KEY = process.env.PAYCHANGU_SECRET_KEY;
    const merchantKey = merchant.paychanguSecretKey || PLATFORM_KEY;
    const usingMerchantKey = !!merchant.paychanguSecretKey;

    if (!merchantKey) {
        return res.status(500).json({
            success: false,
            error: 'No PayChangu key available'
        });
    }

    console.log(`Payment for merchant ${merchant.id} using ${usingMerchantKey ? 'MERCHANT' : 'PLATFORM'} key`);

    let cleanPhone = String(phoneNumber).replace(/\s/g, '').replace('+', '');
    if (cleanPhone.startsWith('265')) cleanPhone = cleanPhone.substring(3);
    if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.substring(1);

    if (cleanPhone.length !== 9) {
        return res.status(400).json({
            success: false,
            error: `Invalid phone (${cleanPhone.length} digits, expected 9)`
        });
    }

    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum < 50) {
        return res.status(400).json({
            success: false,
            error: 'Amount must be at least K50'
        });
    }

    const platformFee = Math.round(amountNum * (PLATFORM_FEE_PERCENT / 100) * 100) / 100;
    const merchantReceives = amountNum - platformFee;

    const chargeId = `PC-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const operatorRef = OPERATORS[provider] || OPERATORS.AIRTEL_MWI;

    const payload = {
        mobile_money_operator_ref_id: operatorRef,
        mobile: cleanPhone,
        amount: String(amount),
        charge_id: chargeId,
        email: email || merchant.email || 'customer@paykwacha.com',
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

        const ttlDate = new Date();
        ttlDate.setDate(ttlDate.getDate() + TRANSACTION_RETENTION_DAYS);

        await db.collection('transactions').doc(chargeId).set({
            chargeId,
            userId: merchant.id,
            phoneNumber: cleanPhone,
            amount: amountNum,
            platformFee,
            merchantReceives,
            provider: provider || 'AIRTEL_MWI',
            status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expireAt: admin.firestore.Timestamp.fromDate(ttlDate)
        });

        await db.collection('fee_ledger').add({
            merchantUserId: merchant.id,
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
            error: pcResponse?.message || pcResponse?.error || error.message,
            raw: pcResponse
        });
    }
});

// ============================================
// 🔍 Verify Single Payment
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
        const merchantKey = merchantDoc.data()?.paychanguSecretKey
            || process.env.PAYCHANGU_SECRET_KEY;

        const response = await axios.get(
            `${PAYCHANGU_URL}/mobile-money/payments/${chargeId}/verify`,
            {
                headers: { 'Authorization': `Bearer ${merchantKey}` }
            }
        );

        const status = (response.data?.data?.status || response.data?.status || '').toLowerCase();

        if ((status === 'success' || status === 'successful') && txnData.status !== 'SUCCESS') {
            await txnDoc.ref.update({
                status: 'SUCCESS',
                verifiedAt: admin.firestore.FieldValue.serverTimestamp()
            });

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
        } else if ((status === 'failed' || status === 'cancelled') && txnData.status === 'PENDING') {
            await txnDoc.ref.update({
                status: 'FAILED',
                verifiedAt: admin.firestore.FieldValue.serverTimestamp()
            });
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
// 🔄 Auto-Verify Pending Transactions
// ============================================
app.get('/api/verify-pending/:userId', async (req, res) => {
    if (!db) {
        return res.status(500).json({ success: false, error: 'Firebase not configured' });
    }

    const { userId } = req.params;

    try {
        const snapshot = await db.collection('transactions')
            .where('userId', '==', userId)
            .where('status', '==', 'PENDING')
            .limit(20)
            .get();

        if (snapshot.empty) {
            return res.json({ success: true, checked: 0, updated: 0 });
        }

        const merchantDoc = await db.collection('businesses').doc(userId).get();
        const merchantKey = merchantDoc.data()?.paychanguSecretKey
            || process.env.PAYCHANGU_SECRET_KEY;

        let updated = 0;

        for (const doc of snapshot.docs) {
            const chargeId = doc.id;
            try {
                const response = await axios.get(
                    `${PAYCHANGU_URL}/mobile-money/payments/${chargeId}/verify`,
                    { headers: { 'Authorization': `Bearer ${merchantKey}` } }
                );

                const status = (response.data?.data?.status || response.data?.status || '').toLowerCase();

                if (status === 'success' || status === 'successful') {
                    await doc.ref.update({
                        status: 'SUCCESS',
                        verifiedAt: admin.firestore.FieldValue.serverTimestamp()
                    });

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
                    updated++;
                } else if (status === 'failed' || status === 'cancelled') {
                    await doc.ref.update({
                        status: 'FAILED',
                        verifiedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    updated++;
                }
            } catch (err) {
                console.log(`Verify ${chargeId} failed:`, err.message);
            }
        }

        res.json({ success: true, checked: snapshot.size, updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 💰 Withdraw
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

        const PLATFORM_KEY = process.env.PAYCHANGU_SECRET_KEY;
        const merchantKey = business.paychanguSecretKey || PLATFORM_KEY;

        if (!merchantKey) {
            return res.status(400).json({
                success: false,
                error: 'No PayChangu key available'
            });
        }

        let cleanPhone = String(phoneNumber).replace(/\s/g, '').replace('+', '');
        if (cleanPhone.startsWith('265')) cleanPhone = cleanPhone.substring(3);
        if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.substring(1);

        if (cleanPhone.length !== 9) {
            return res.status(400).json({
                success: false,
                error: `Invalid phone (${cleanPhone.length} digits)`
            });
        }

        const chargeId = `WD-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const operatorRef = provider === 'TNM_MWI' ? OPERATORS.TNM_MWI : OPERATORS.AIRTEL_MWI;

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

        await db.collection('businesses').doc(userId).update({
            balance: admin.firestore.FieldValue.increment(-withdrawAmount)
        });

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
        const errData = error.response?.data;
        res.status(500).json({
            success: false,
            error: errData?.message || errData?.error || error.message,
            raw: errData
        });
    }
});

// ============================================
// 🔗 Connect PayChangu Key
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
        await axios.get(`${PAYCHANGU_URL}/mobile-money/operators`, {
            headers: { 'Authorization': `Bearer ${secretKey}` }
        });

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