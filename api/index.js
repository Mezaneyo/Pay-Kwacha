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

    // --- Generate proper UUID for depositId ---
    const depositId = require('crypto').randomUUID();

    // --- Build payload with EXACT pawaPay format ---
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
    console.log('URL:', `${PAWAPAY_URL}/deposits`);
    console.log('Payload:', JSON.stringify(payload, null, 2));

    try {
        const response = await axios.post(
            `${PAWAPAY_URL}/deposits`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${PAWAPAY_TOKEN}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
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
        console.error('Request Payload:', JSON.stringify(payload, null, 2));

        const pawaResponse = error.response?.data;
        let errorMessage = 'Payment failed. Please try again.';
        let validationErrors = [];

        if (pawaResponse) {
            // pawaPay's standard error format
            if (pawaResponse.errorMessage) {
                errorMessage = pawaResponse.errorMessage;
            } else if (pawaResponse.message) {
                errorMessage = pawaResponse.message;
            } else if (pawaResponse.errorCode) {
                errorMessage = `${pawaResponse.errorCode}: ${pawaResponse.errorMessage || ''}`;
            } else if (pawaResponse.failureReason) {
                errorMessage = pawaResponse.failureReason;
            } else if (pawaResponse.error) {
                if (typeof pawaResponse.error === 'string') {
                    errorMessage = pawaResponse.error;
                } else {
                    errorMessage = `pawaPay error: ${JSON.stringify(pawaResponse.error)}`;
                }
            }

            // pawaPay sometimes returns a "failures" array with details
            if (pawaResponse.failures && Array.isArray(pawaResponse.failures)) {
                validationErrors = pawaResponse.failures.map(f => ({
                    code: f.failureCode,
                    message: f.failureMessage,
                    field: f.field
                }));
                if (validationErrors.length > 0 && !pawaResponse.errorMessage) {
                    errorMessage = validationErrors
                        .map(f => `${f.field || 'field'}: ${f.message || f.code}`)
                        .join('; ');
                }
            }
        } else if (error.code === 'ECONNABORTED') {
            errorMessage = 'Request timed out';
        } else if (error.message) {
            errorMessage = error.message;
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            validationErrors: validationErrors,
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
