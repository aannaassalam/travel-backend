import stripe from 'stripe'
import Razorpay from 'razorpay'
import axios, { AxiosError } from 'axios'
import uniqid from 'uniqid'
import sha256 from 'sha256'
import AppError from './appError'
import crypto from 'crypto'

// Stripe configuration
const stripeSecretKey = process.env.STRIPE_SECTET_KEY
const stripeClient = new stripe(stripeSecretKey, {
   apiVersion: '2023-10-16', // Updated API version
})

// Razorpay configuration
const razorpayKeyId = process.env.RAZOREPAY_KEY_ID
const razorpayKeySecret = process.env.RAZOREPAY_SECTET_KEY
const merchantTransactionId = uniqid()
const razorpayClient = new Razorpay({
   key_id: razorpayKeyId,
   key_secret: razorpayKeySecret,
})

export function createStripePaymentIntent(amount: number, currency: string) {
   return stripeClient.paymentIntents.create({
      amount,
      currency,
   })
}

export async function createRazorpayOrder(
   amount: number,
   currency: string,
   receipt: string
) {
   try {
      const payment_capture = 1
      const options = {
         amount: parseFloat((amount * 100).toFixed(2)), // Amount in paise
         currency,
         receipt,
         payment_capture: payment_capture,
      }
      const order = await razorpayClient.orders.create(options)
      return order
   } catch (err) {

      return new AppError('failed to create order', 400)
   }
}

// Function to get order details by Razorpay orderId
export async function getRazorpayOrderDetails(orderId: string) {
   try {
      const orderDetails = await makeRazorpayRequest(
         `/orders/${orderId}`,
         'GET'
      )
      return orderDetails
   } catch (error) {
      return new Error(
         'Error fetching Razorpay order details: ' + error.message
      )
   }
}

export async function processStripeRefund(paymentIntentId: string) {
   return stripeClient.refunds.create({
      payment_intent: paymentIntentId,
   })
}
export async function withdrawByRazorpayX(
   account: any,
   amount: number,
   contactDetails: any
) {
   try {
      const payload = {
         account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER,
         amount: amount * 100,
         currency: 'INR',
         mode: 'NEFT',
         purpose: 'refund',
         fund_account: {
            account_type: 'bank_account',
            bank_account: {
               name: account.name,
               ifsc: account.ifsc,
               account_number: account.accountNumber,
            },
            contact: {
               name: contactDetails.name,
               email: contactDetails.email,
               contact: contactDetails.phone,
               type: 'customer',
               reference_id: contactDetails.userId,
               notes: {
                  notes_key_1: `${contactDetails.name} (${contactDetails.userId}) created a withdraw request of RS: ${amount}`,
               },
            },
         },
         queue_if_low_balance: true,
         reference_id: merchantTransactionId,
         narration: 'Fund withdrawn from withdrawal balance',
         notes: {
            notes_key_1: 'Fund withdrawn from withdraw balance',
         },
      }
      const withdrawAmount = await makeRazorpayRequest(
         '/payouts',
         'POST',
         payload
      )
      return withdrawAmount
   } catch (err) {
      return new AppError('failed to withdraw ', 400)
   }
}
export async function processRazorpayRefund(
   paymentId: string,
   refundAmount: number
) {
   try {
      // Create Razorpay refund
      const refund = await razorpayClient.payments.refund(paymentId, {
         amount: refundAmount * 100, // Amount in paise
      })
      return refund
   } catch (error) {
      return new Error('Razorpay refund failed: ' + error.message)
   }
}

async function makeRazorpayRequest(
   url: string,
   method: 'GET' | 'POST' | 'PUT' | 'DELETE',
   data?: any
) {
   try {
      const response = await axios({
         method,
         url: `https://api.razorpay.com/v1${url}`,
         auth: {
            username: razorpayKeyId,
            password: razorpayKeySecret,
         },
         data,
      })
      return response.data
   } catch (error) {
      return new Error('Razorpay API request failed: ' + error.message)
   }
}

// Function to get Razorpay user's current balance
export async function getRazorpayUserBalance() {
   try {
      const balance = await makeRazorpayRequest('/payments/balance', 'GET')
      return balance
   } catch (error) {
      return new Error('Error fetching Razorpay user balance: ' + error.message)
   }
}

// Function to get debit list from Razorpay
export async function getRazorpayDebitList() {
   try {
      const debits = await makeRazorpayRequest('/payments', 'GET', {
         entity: 'debit',
      })
      return debits
   } catch (error) {
      return new Error('Error fetching Razorpay debit list: ' + error.message)
   }
}

// Function to get collected amounts from Razorpay
export async function getRazorpayCollectedAmounts() {
   try {
      const collectedAmounts = await makeRazorpayRequest('/payments', 'GET', {
         entity: 'payment',
      })
      return collectedAmounts
   } catch (error) {
      return new Error(
         'Error fetching Razorpay collected amounts: ' + error.message
      )
   }
}

// Function to get payment list from Razorpay
export async function getRazorpayPaymentList() {
   try {
      const payments = await makeRazorpayRequest('/payments', 'GET')
      return payments
   } catch (error) {
      return new Error('Error fetching Razorpay payment list: ' + error.message)
   }
}

// Function to get failed payment list from Razorpay
export async function getRazorpayFailedPaymentList() {
   try {
      const failedPayments = await makeRazorpayRequest('/payments', 'GET', {
         status: 'failed',
      })
      return failedPayments
   } catch (error) {
      return new Error(
         'Error fetching Razorpay failed payment list: ' + error.message
      )
   }
}

// Function to get refund amount from Razorpay
export async function getRazorpayRefundAmount() {
   try {
      const refunds = await makeRazorpayRequest('/refunds', 'GET')
      return refunds
   } catch (error) {
      return new Error(
         'Error fetching Razorpay refund amount: ' + error.message
      )
   }
}

//phonePe
const PHONE_PE_HOST_URL = process.env.PHONEPE_HOST_URL
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID
const SALT_INDEX = process.env.PHONEPE_SALT_INDEX
const SALT_KEY = process.env.PHONEPE_SALT_KEY

export async function phonePePayRequest(formData: any) {
   const payEndPoint = '/pg/v1/pay'
   const queryParams = new URLSearchParams({
      userId: formData.userId,
      service: JSON.stringify(formData.service),
      walletAmount: formData.walletAmount,
      voucherAmount: formData.voucherAmount,
      voucherCode: formData.voucherCode,
      client: formData.client,
      partner: formData.partner,
      successPage: formData.successPage,
      failedPage: formData.failedPage,
   })
   const redirectUrl = `${process.env.URL}/api/v1/payment/redirect-url/${merchantTransactionId}/?${queryParams}`
   // const redirectUrl = `http://localhost:3001/api/v1/payment/redirect-url/${merchantTransactionId}/?${queryParams}`

   const payload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: merchantTransactionId,
      merchantUserId: formData.userId,
      amount: parseFloat((formData.amount * 100).toFixed(2)),
      redirectUrl: redirectUrl,
      redirectMode: 'REDIRECT',
      mobileNumber: formData.phone,
      paymentInstrument: {
         type: 'PAY_PAGE',
      },
   }


   const bufferObj = Buffer.from(JSON.stringify(payload), 'utf-8')
   const base6EncodedPayload = bufferObj.toString('base64')
   const xVerify =
      sha256(base6EncodedPayload + payEndPoint + SALT_KEY) + '###' + SALT_INDEX
   // console.log();
   const options = {
      method: 'post',
      url: `${PHONE_PE_HOST_URL}${payEndPoint}`,
      headers: {
         accept: 'application/json',
         // accept: 'text/plain',
         'Content-Type': 'application/json',
         'X-VERIFY': xVerify,
      },
      data: {
         request: base6EncodedPayload,
      },
   }
   try {
      const response = await axios.request(options)

      return response.data.data.instrumentResponse.redirectInfo.url // Return the response from PhonePe
   } catch (error) {
      console.error(error)
      return new Error('Error while making payment request to PhonePe')
   }
}
export async function phonePePayRequestInRecurring(formData: any) {
   const payEndPoint = '/pg/v1/pay'
   const queryParams = new URLSearchParams({
      userId: formData.userId,
      occurrences: JSON.stringify(formData.occurrences),
      purchasedRecurringId: formData.purchasedRecurringId,
      client: formData.client,
      partner: formData.partner,
      successPage: formData.successPage,
      failedPage: formData.failedPage,
   })
   
   const redirectUrl = `${process.env.URL}/api/v1/payment/recurring/phonepe-redirect-url/${merchantTransactionId}/?${queryParams}`
   // const redirectUrl = `http://localhost:3001/api/v1/payment/redirect-url/${merchantTransactionId}/?${queryParams}`

   const payload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: merchantTransactionId,
      merchantUserId: formData.userId,
      amount: parseFloat((formData.amount * 100).toFixed(2)),
      redirectUrl: redirectUrl,
      redirectMode: 'REDIRECT',
      mobileNumber: formData.phone,
      paymentInstrument: {
         type: 'PAY_PAGE',
      },
   }


   const bufferObj = Buffer.from(JSON.stringify(payload), 'utf-8')
   const base6EncodedPayload = bufferObj.toString('base64')
   const xVerify =
      sha256(base6EncodedPayload + payEndPoint + SALT_KEY) + '###' + SALT_INDEX
   // console.log();
   const options = {
      method: 'post',
      url: `${PHONE_PE_HOST_URL}${payEndPoint}`,
      headers: {
         accept: 'application/json',
         // accept: 'text/plain',
         'Content-Type': 'application/json',
         'X-VERIFY': xVerify,
      },
      data: {
         request: base6EncodedPayload,
      },
   }
   try {
      const response = await axios.request(options)

      return response.data.data.instrumentResponse.redirectInfo.url // Return the response from PhonePe
   } catch (error) {
      console.error(error)
      return new Error('Error while making payment request to PhonePe')
   }
}

export async function phonePePaymentStatus(merchantTransactionId: string) {
   const xVerify =
      sha256(
         `/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}` + SALT_KEY
      ) +
      '###' +
      SALT_INDEX
   const options = {
      method: 'get',
      url: `${PHONE_PE_HOST_URL}/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}`,
      headers: {
         accept: 'application/json',
         'Content-Type': 'application/json',
         'X-MERCHANT-ID': merchantTransactionId,
         'X-VERIFY': xVerify,
      },
   }
   try {
      const response = await axios.request(options)
      return response.data // Return the response from PhonePe
   } catch (error) {
      return new AppError('Error while making payment request to PhonePe', 400)
   }
}

export async function withdrawFromPhonePe(accountDetails: any, amount: number) {
   try {
      // Construct the withdrawal payload
      const withdrawalPayload = {
         account: accountDetails, // User's bank account details
         amount: amount * 100, // Amount in paise
         currency: 'INR', // Assuming currency is INR
         notes: 'Withdrawal from PhonePe to bank account',
      }
      const xVerify =
         sha256(
            `/pg/v1/withdraw/${MERCHANT_ID}/${merchantTransactionId}` + SALT_KEY
         ) +
         '###' +
         SALT_INDEX
      // Make a request to PhonePe's withdrawal API
      const response = await axios.post(
         `${process.env.PHONEPE_HOST_URL}/pg/v1/withdraw`,
         withdrawalPayload,
         {
            headers: {
               accept: 'application/json',
               'Content-Type': 'application/json',
               'X-VERIFY': xVerify, // Replace with your X-VERIFY token
            },
         }
      )

      // Handle response, update status, log transaction, etc.
      // Return success response or other relevant data
      // Return success response or other relevant data
      return response.data
   } catch (error) {
      return new Error('PhonePe withdrawal failed: ' + error.message)
   }
}

// implement payu checkOut with callback url
export async function payUCheckOut(formData: any) {
   const queryParams = new URLSearchParams({
      userId: formData.userId,
      service: JSON.stringify(formData.service),
      walletAmount: formData.walletAmount,
      voucherAmount: formData.voucherAmount,
      client: formData.client,
      partner: formData.partner,
      successPage: formData.successPage,
      failedPage: formData.failedPage,
   });

   // Transaction ID
   const txnid = 'Txn' + new Date().getTime();

   // Redirect URL for success callback
   const redirectUrl = `${process.env.URL}/api/v1/payment/redirect-url/${txnid}/?${queryParams}`;

   // PayU configuration from environment variables
   const payUConfig = {
      merchantKey: process.env.PAYU_MERCHANT_KEY as string,
      merchantSalt: process.env.PAYU_MERCHANT_SALT as string,
      payUBaseURL: process.env.PAYU_BASE_URL as string,
      successURL: redirectUrl as string,  // Success URL
      failureURL: formData.failedPage as string,  // Failure URL
   };

   // Prepare the hash string as per PayU requirements
   const hashString = `${payUConfig.merchantKey}|${txnid}|${parseFloat(formData.amount).toFixed(2)}|Product Info|${formData.name}|${formData.email}|||||||||||${payUConfig.merchantSalt}`;
   const hash = crypto.createHash('sha512').update(hashString).digest('hex');

   // Prepare the payload for PayU
   const payUData = {
      key: payUConfig.merchantKey,
      txnid,
      amount: parseFloat(formData.amount).toFixed(2), // Ensure 2 decimal places
      productinfo: 'Product Info',
      firstname: formData.name,
      email: formData.email,
      phone: formData.phone,
      surl: payUConfig.successURL,
      furl: payUConfig.failureURL,
      hash,
   };

   // Convert data to URL-encoded format
   const formBody = new URLSearchParams(payUData).toString();

   const options = {
      method: 'post',
      url: `${payUConfig.payUBaseURL}`,
      headers: {
         'Content-Type': 'application/x-www-form-urlencoded',  // Use form-urlencoded as required by PayU
      },
      data: formBody,
   };

   try {
      const response = await axios.request(options);

      return response.data; // Return the response from PayU
   } catch (error) {
      console.error(error.response ? error.response.data : error);
      throw new AppError('Error while making payment request to PayU', 400);
   }
}


export async function payUVerifyPayment(transactionId: string) {
   try {
      const HASH_VERIFY_URL = process.env.PAYU_ENV === 'production'
         ? "https://info.payu.in/merchant/postservice.php?form=2"
         : "https://test.payu.in/merchant/postservice?form=2";

      const command = "verify_payment";
      const hashString = `${process.env.PAYU_MERCHANT_KEY}|${command}|${transactionId}|${process.env.PAYU_MERCHANT_SALT}`;
      const hash = crypto.createHash('sha512').update(hashString).digest('hex');


      // Prepare the form data for the request
      const formData = {
         key: process.env.PAYU_MERCHANT_KEY,
         hash,
         var1: transactionId,
         command: command,
      };

      // Send the request to PayU's verification endpoint
      const response = await axios.post(HASH_VERIFY_URL, formData, {
         headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
         },
      });


      return response.data;
   } catch (error) {
      console.error('Error during payment verification:', error);
      throw new Error('Error during payment verification');
   }
}