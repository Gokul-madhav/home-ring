const express = require("express");
const router = express.Router();
const db = require("../firebase");
const { v4: uuidv4 } = require("uuid");
const generateQR = require("../utils/qrGenerator");

// Agora configuration
const AGORA_APP_ID = "e99f68decc74469e93db09796e5ccd8c";
const AGORA_APP_CERTIFICATE = "42c79730f2a04138a26c5a8339e005d8"; // Add your Agora app certificate

// ✅ Generate new QR code and store in RTDB
router.post("/generate", async (req, res) => {
  try {
    const doorID = uuidv4();
    const qrCode = await generateQR(doorID);

    await db.ref(`doors/${doorID}`).set({
      claimed: false,
      claimedBy: null,
      createdAt: new Date().toISOString()
    });

    res.json({ doorID, qrCode });
  } catch (error) {
    console.error("QR generation failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});


// ✅ Activate QR code for doorbell
router.post("/activate", async (req, res) => {
  try {
    const { doorID, ownerID, phoneNumber } = req.body;

    if (!doorID || !ownerID) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const snapshot = await db.ref(`doors/${doorID}`).once("value");
    
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Door ID not found" });
    }

    const doorData = snapshot.val();
    
    if (doorData.claimed) {
      return res.status(400).json({ error: "Door already claimed" });
    }

    // Update door with owner information
    await db.ref(`doors/${doorID}`).update({
      claimed: true,
      claimedBy: ownerID,
      ownerPhone: phoneNumber||null,
      status: 'active',
      activatedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    });

    // Add to user's doorbells
    await db.ref(`users/${ownerID}/doorbells/${doorID}`).set({
      doorID: doorID,
      status: 'active',
      activatedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    });

    res.json({ 
      success: true, 
      message: "Doorbell activated successfully",
      doorID: doorID 
    });
  } catch (error) {
    console.error("QR activation failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Get user's doorbells
router.get("/my-doorbells", async (req, res) => {
  try {
    const ownerID = req.query.ownerID || 'user_123'; // TODO: Get from auth
    
    const snapshot = await db.ref(`users/${ownerID}/doorbells`).once("value");
    
    if (!snapshot.exists()) {
      return res.json({ doorbells: [] });
    }

    const doorbells = [];
    snapshot.forEach((childSnapshot) => {
      doorbells.push(childSnapshot.val());
    });

    res.json({ doorbells });
  } catch (error) {
    console.error("Failed to get doorbells:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Deactivate doorbell
router.post("/deactivate", async (req, res) => {
  try {
    const { doorID } = req.body;
    const ownerID = req.body.ownerID || 'user_123'; // TODO: Get from auth

    await db.ref(`doors/${doorID}/status`).set('inactive');
    await db.ref(`users/${ownerID}/doorbells/${doorID}/status`).set('inactive');

    res.json({ success: true, message: "Doorbell deactivated" });
  } catch (error) {
    console.error("Deactivation failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Delete doorbell
router.delete("/:doorID", async (req, res) => {
  try {
    const { doorID } = req.params;
    // Try to get ownerID from body or query
    const ownerID = req.body.ownerID || req.query.ownerID;

    await db.ref(`doors/${doorID}`).remove();
    await db.ref(`users/${ownerID}/doorbells/${doorID}`).remove();

    res.json({ success: true, message: "Doorbell deleted" });
  } catch (error) {
    console.error("Deletion failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Initiate video call (visitor endpoint)
router.post("/call/:doorID", async (req, res) => {
  try {
    const { doorID } = req.params;
    const { visitorName } = req.body;

    const snapshot = await db.ref(`doors/${doorID}`).once("value");
    
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Door ID not found" });
    }

    const doorData = snapshot.val();
    
    if (!doorData.claimed || doorData.status !== 'active') {
      return res.status(400).json({ error: "Doorbell not active" });
    }

    // Generate unique channel name for this call
    const channelName = `doorbell_${doorID}_${Date.now()}`;
    
    // Generate Agora token (you'll need to implement this)
    const token = generateAgoraToken(channelName);

    // Store call information
    const callID = uuidv4();
    await db.ref(`calls/${callID}`).set({
      doorID: doorID,
      channelName: channelName,
      visitorName: visitorName,
      status: 'ringing',
      createdAt: new Date().toISOString(),
      ownerPhone: doorData.ownerPhone || null, // <--- Fix: use null if undefined
      ownerID: doorData.claimedBy || null
    });

    // Update doorbell last activity
    await db.ref(`doors/${doorID}/lastActivity`).set(new Date().toISOString());
    await db.ref(`users/${doorData.claimedBy}/doorbells/${doorID}/lastActivity`).set(new Date().toISOString());

    res.json({
      success: true,
      callID: callID,
      channelName: channelName,
      agoraAppId: AGORA_APP_ID,
      token: token
    });
  } catch (error) {
    console.error("Call initiation failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Get call status
router.get("/call/:callID/status", async (req, res) => {
  try {
    const { callID } = req.params;
    
    const snapshot = await db.ref(`calls/${callID}`).once("value");
    
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Call not found" });
    }

    res.json(snapshot.val());
  } catch (error) {
    console.error("Failed to get call status:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Accept call (owner endpoint)
router.post("/call/:callID/accept", async (req, res) => {
  try {
    const { callID } = req.params;
    
    await db.ref(`calls/${callID}/status`).set('accepted');
    
    res.json({ success: true, message: "Call accepted" });
  } catch (error) {
    console.error("Call acceptance failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ End call
router.post("/call/:callID/end", async (req, res) => {
  try {
    const { callID } = req.params;
    
    await db.ref(`calls/${callID}/status`).set('ended');
    await db.ref(`calls/${callID}/endedAt`).set(new Date().toISOString());
    
    res.json({ success: true, message: "Call ended" });
  } catch (error) {
    console.error("Call ending failed:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Get incoming calls for owner
router.get("/call/incoming", async (req, res) => {
  try {
    const { ownerID } = req.query;
    if (!ownerID) return res.status(400).json({ error: "Missing ownerID" });

    const snapshot = await db.ref("calls").orderByChild("ownerID").equalTo(ownerID).once("value");
    const calls = [];
    snapshot.forEach(child => {
      const call = child.val();
      if (call.status === "ringing") {
        calls.push({ ...call, callID: child.key });
      }
    });
    res.json({ calls });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});


// ✅ Get door status from RTDB
router.get("/:doorID", async (req, res) => {
  const { doorID } = req.params;
  const snapshot = await db.ref(`doors/${doorID}`).once("value");

  if (!snapshot.exists()) {
    return res.status(404).json({ message: "Invalid door ID" });
  }

  res.json(snapshot.val());
});

// Helper function to generate Agora token
function generateAgoraToken(channelName) {
  // TODO: Implement proper Agora token generation
  // For now, return null (no token required for testing)
  return null;
}

module.exports = router;
