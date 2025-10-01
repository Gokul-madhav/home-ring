const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://home-ring-b24e4-default-rtdb.firebaseio.com"
});

const db = admin.database();
const messaging = admin.messaging();

module.exports = { db, messaging, admin };
