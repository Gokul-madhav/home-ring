const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://home-ring-b24e4-default-rtdb.firebaseio.com" // ✅ Replace with your RTDB URL
});

const db = admin.database(); // ✅ RTDB object
module.exports = db;
