require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { MongoClient, ServerApiVersion } = require('mongodb')
const admin = require('firebase-admin')
const port = process.env.PORT || 3000
const dns = require("dns");
// Change DNS
dns.setServers(["1.1.1.1", "8.8.8.8"]);
// console.log(process.env.STRIPE_SECRET_KEY);
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

let isFirebaseInitialized = false
const fbServiceKeyBase64 = process.env.FB_SERVICE_KEY

if (fbServiceKeyBase64) {
  const decoded = Buffer.from(fbServiceKeyBase64, 'base64').toString('utf-8')
  const serviceAccount = JSON.parse(decoded)
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  })
  isFirebaseInitialized = true
} else {
  console.warn(
    'FB_SERVICE_KEY is missing in environment. Firebase auth middleware will respond with 500 until configured.'
  )
}
const app = express()
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionsSuccessStatus: 200,
  })
);
app.use(express.json())

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  // console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    // console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})
async function run() {
  try {

    // Send a ping to confirm a successful connection
    const db = client.db('blood-donation');
    const requestCollection = db.collection('requests')
    const userCollection = db.collection('users')
    const volunteerRequestCollection = db.collection('volunteerRequest')
    const donationCollection = db.collection('donation')
    // verifyADMIN
    const verifyADMIN = async (req, res, next) => {
      try {
        const email = req.tokenEmail;

        const user = await userCollection.findOne({ email });
        if (user?.role !== "admin") {
          return res
            .status(403)
            .send({ message: "Only admin can access this route" });
        }
        next();
      } catch (error) {
        console.error("verifyADMIN error:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    };
    // verifyVOLUNTEER
    const verifyVOLUNTEER = async (req, res, next) => {
      const email = req.tokenEmail
      const user = await userCollection.findOne({ email })
      if (user?.role !== 'volunteer')
        return res
          .status(403)
          .send({ message: "Only Volunteer Access this" })
      next()
    }

    //  save data to mongodb
    app.post('/request', async (req, res) => {
      const requestData = req.body
      // console.log(requestData);

      const result = await requestCollection.insertOne(requestData)
      res.send(result)
    })

    // get data from serverSide
    app.get('/request', async (req, res) => {
      const result = await requestCollection.find().toArray()
      // console.log(result);

      res.send(result)

    })


    // Get data the Register User
    app.get('/my-request/:email', async (req, res) => {
      const email = req.params.email
      const result = await requestCollection.find({ user: email }).toArray()
      res.send(result)
    })

    // Save or updata user data in mongodb
    app.post('/user', async (req, res) => {
      const userData = req.body
      userData.created_at = new Date().toISOString()
      userData.last_logIn = new Date().toISOString()

      userData.role = 'donor'
      const query = {
        email: userData.email
      }

      const alreadyExists = await userCollection.findOne(query)
      console.log("User already exist---->", !!alreadyExists);
      if (alreadyExists) {
        console.log("updating user info.....");
        const result = await userCollection.updateOne(query, {
          $set: {
            last_logIn: new Date().toISOString()
          },
        })
        return res.send(result)
      }

      console.log("saving user info.....");
      const result = await userCollection.insertOne(userData)

    })

    // get user role
    app.get('/user/role', verifyJWT, async (req, res) => {
      const result = await userCollection.findOne({ email: req.tokenEmail })
      res.send({ role: result?.role })
    })

    // save become a Volunteer 
    app.post('/become-volunteer', verifyJWT, async (req, res) => {
      const email = req.tokenEmail
      const alreadyExists = await volunteerRequestCollection.findOne({ email })
      if (alreadyExists) {
        return res
          .status(409)
          .send({ message: 'Already Requested,please wait!' })
      }

      const result = await volunteerRequestCollection.insertOne({ email })
      res.send(result)
    })

    //get all volunteer request data
    app.get('/volunteer-request', async (req, res) => {
      const result = await volunteerRequestCollection.find().toArray()
      res.send(result)
    })
    app.get('/users', verifyJWT, verifyADMIN, async (req, res) => {
      const adminEmail = req.tokenEmail
      const result = await userCollection.find({
        email: { $ne: adminEmail }
      }).toArray()

      res.send(result)
    })
    // update user role
    app.patch('/update-role', verifyJWT, async (req, res) => {
      const { email, role } = req.body
      const result = await userCollection.updateOne({ email }, {
        $set: { role }
      })
      await volunteerRequestCollection.deleteOne({ email })
      res.send(result);

    })
    // update user profile
    app.patch("/user/profile", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const updatedData = req.body;
      delete updatedData.email;
      const result = await userCollection.updateOne(
        { email },
        { $set: updatedData }
      );

      res.send(result);
    });

    // payment endpoints
    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body
      console.log(paymentInfo);

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "Medical Fund Donation",
              },
              unit_amount: paymentInfo.amount * 100, // cents
            },
            quantity: 1,
          },

        ],
        metadata: {
          UserId: paymentInfo?.name,
          email: paymentInfo?.email
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/funding`,
        customer_email: paymentInfo?.email,
        mode: 'payment'
      })
      res.send({ url: session.url })
    })

    app.post('/payment-success', async (req, res) => {
      const { sessionId } = req.body
      const session = await stripe.checkout.sessions.retrieve(sessionId)
      // console.log(session);
      const donation = await donationCollection.findOne({ transactionId: session.payment_intent })
      if (session.status === 'complete' && !donation) {
        //  save payment information in database
        const donationInfo = {
          transactionId: session.payment_intent,
          name: session.metadata.UserId,
          email: session.customer_email,
          donationAmount: session.amount_total / 100,
          payment_at: new Date().toISOString(),
          status: 'pending'
        };
        const result = await donationCollection.insertOne(donationInfo)


      }

    })

    // get all donation user data
    app.get('/donation', async (req, res) => {
      const result = await donationCollection.find().toArray()
      res.send(result)
    })

    await client.db('admin').command({ ping: 1 })
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    )
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir)

app.get('/', (req, res) => {
  res.send('Hello from Server..')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})
