require("dotenv").config();

const express = require("express");
const cors = require("cors");
const dns = require("dns");
const { MongoClient, ServerApiVersion } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

dns.setServers(["1.1.1.1", "8.8.8.8"]);

const app = express();

const allowedOrigins = [
  "https://blood-donation-7fa22.web.app",
  "https://blood-donation-7fa22.firebaseapp.com",
  "http://localhost:5173",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.error("CORS blocked origin:", origin);
        callback(new Error(`CORS blocked: ${origin}`));
      }
    },
    credentials: true,
  })
);

app.use(express.json());

//  FIREBASE INIT 

let isFirebaseInitialized = false;

try {
  const fbServiceKeyBase64 = process.env.FB_SERVICE_KEY;

  if (fbServiceKeyBase64) {
    const decoded = Buffer.from(fbServiceKeyBase64, "base64").toString("utf-8");
    const serviceAccount = JSON.parse(decoded);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

    isFirebaseInitialized = true;
    console.log("Firebase initialized");
  } else {
    console.warn("FB_SERVICE_KEY missing");
  }
} catch (error) {
  console.error("Firebase initialization failed:", error);
}


//  JWT VERIFY 

const verifyJWT = async (req, res, next) => {
  try {
    if (!isFirebaseInitialized) {
      return res.status(500).send({ message: "Firebase not initialized" });
    }

    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).send({ message: "Unauthorized Access" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;

    next();
  } catch (error) {
    console.error("JWT Verify Error:", error);
    res.status(401).send({ message: "Unauthorized Access" });
  }
};


//  MONGODB 

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let requestCollection;
let userCollection;
let volunteerRequestCollection;
let donationCollection;

async function connectDB() {
  try {
    await client.connect();
    console.log("MongoDB connected");

    const db = client.db("blood-donation");

    requestCollection = db.collection("requests");
    userCollection = db.collection("users");
    volunteerRequestCollection = db.collection("volunteerRequest");
    donationCollection = db.collection("donation");

    await client.db("admin").command({ ping: 1 });
    console.log("MongoDB Ping Success");
  } catch (error) {
    console.error("MongoDB Connection Error:", error);
  }
}

connectDB();


//  ROLE MIDDLEWARES

const verifyADMIN = async (req, res, next) => {
  try {
    const user = await userCollection.findOne({ email: req.tokenEmail });

    if (user?.role !== "admin") {
      return res.status(403).send({ message: "Only admin can access this route" });
    }

    next();
  } catch (error) {
    console.error("verifyADMIN Error:", error);
    res.status(500).send({ message: "Internal Server Error" });
  }
};

const verifyVOLUNTEER = async (req, res, next) => {
  try {
    const user = await userCollection.findOne({ email: req.tokenEmail });

    if (user?.role !== "volunteer") {
      return res.status(403).send({ message: "Only Volunteer Access this" });
    }

    next();
  } catch (error) {
    console.error("verifyVOLUNTEER Error:", error);
    res.status(500).send({ message: "Internal Server Error" });
  }
};


//  ROUTES 

app.get("/", (req, res) => {
  res.send("Blood Donation Server Running");
});


// Request Routes 

// protected — only logged-in users can create a request
app.post("/request", verifyJWT, async (req, res) => {
  try {
    const result = await requestCollection.insertOne(req.body);
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to save request" });
  }
});

// public — anyone can browse blood requests
app.get("/request", async (req, res) => {
  try {
    const result = await requestCollection.find().toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to fetch requests" });
  }
});

// protected — user can only see their own requests
app.get("/my-request/:email", verifyJWT, async (req, res) => {
  try {
    const email = req.params.email;

    if (email !== req.tokenEmail) {
      return res.status(403).send({ message: "Forbidden" });
    }

    const result = await requestCollection.find({ user: email }).toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to fetch user requests" });
  }
});


//  User Routes

// public — called on login/register to save user
app.post("/user", async (req, res) => {
  try {
    const userData = req.body;
    userData.created_at = new Date().toISOString();
    userData.last_logIn = new Date().toISOString();

    const query = { email: userData.email };
    const alreadyExists = await userCollection.findOne(query);

    if (alreadyExists) {
      const result = await userCollection.updateOne(query, {
        $set: { last_logIn: new Date().toISOString() },
      });
      return res.send(result);
    }

    userData.role = "donor";
    const result = await userCollection.insertOne(userData);
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to save user" });
  }
});

//  protected — verifyJWT sets req.tokenEmail, which findOne uses to get the role
app.get("/user/role", verifyJWT, async (req, res) => {
  try {
    const result = await userCollection.findOne({ email: req.tokenEmail });
    res.send({ role: result?.role });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to get role" });
  }
});

// protected — user can update their own profile
app.patch("/user/profile", verifyJWT, async (req, res) => {
  try {
    const updatedData = req.body;
    delete updatedData.email;
    delete updatedData.role; // prevent role escalation

    const result = await userCollection.updateOne(
      { email: req.tokenEmail },
      { $set: updatedData }
    );
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update profile" });
  }
});

// protected + admin only
app.get("/users", verifyJWT, verifyADMIN, async (req, res) => {
  try {
    const result = await userCollection
      .find({ email: { $ne: req.tokenEmail } })
      .toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to fetch users" });
  }
});

// protected + admin only
app.patch("/update-role", verifyJWT, verifyADMIN, async (req, res) => {
  try {
    const { email, role } = req.body;

    const result = await userCollection.updateOne(
      { email },
      { $set: { role } }
    );

    await volunteerRequestCollection.deleteOne({ email });
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update role" });
  }
});


// Volunteer Routes 

// protected — must be logged in to request volunteer
app.post("/become-volunteer", verifyJWT, async (req, res) => {
  try {
    const email = req.tokenEmail;
    const alreadyExists = await volunteerRequestCollection.findOne({ email });

    if (alreadyExists) {
      return res.status(409).send({ message: "Already Requested, please wait!" });
    }

    const result = await volunteerRequestCollection.insertOne({ email });
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to submit volunteer request" });
  }
});

// protected + admin only
app.get("/volunteer-request", verifyJWT, verifyADMIN, async (req, res) => {
  try {
    const result = await volunteerRequestCollection.find().toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to fetch volunteer requests" });
  }
});


// Payment / Donation Routes 

//  protected — must be logged in to donate
app.post("/create-checkout-session", verifyJWT, async (req, res) => {
  try {
    const paymentInfo = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Medical Fund Donation" },
            unit_amount: paymentInfo.amount * 100,
          },
          quantity: 1,
        },
      ],
      metadata: {
        UserId: paymentInfo?.name,
        email: paymentInfo?.email,
      },
      success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_DOMAIN}/funding`,
      customer_email: paymentInfo?.email,
      mode: "payment",
    });

    res.send({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Stripe session failed" });
  }
});

// public — Stripe redirects here after payment, no user session available
app.post("/payment-success", async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const donation = await donationCollection.findOne({
      transactionId: session.payment_intent,
    });

    if (session.status === "complete" && !donation) {
      await donationCollection.insertOne({
        transactionId: session.payment_intent,
        name: session.metadata.UserId,
        email: session.customer_email,
        donationAmount: session.amount_total / 100,
        payment_at: new Date().toISOString(),
        status: "pending",
      });
    }

    res.send({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Payment verification failed" });
  }
});

// public — donation records are shown on the public funding page
app.get("/donation", async (req, res) => {
  try {
    const result = await donationCollection.find().toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to fetch donations" });
  }
});


// GLOBAL ERROR HANDLER 

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send({ message: "Something broke!" });
});


//  START SERVER

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;