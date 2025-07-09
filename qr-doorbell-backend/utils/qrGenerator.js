const QRCode = require("qrcode");
const fs = require("fs");

async function generateQR(doorID) {
  const url = `https://homering.onrender.com/${doorID}`;
  const filePath = `./qr-codes/${doorID}.png`;

  // Create folder if it doesn't exist
  if (!fs.existsSync("./qr-codes")) {
    fs.mkdirSync("./qr-codes");
  }

  await QRCode.toFile(filePath, url);  // ✅ Save as file
  return await QRCode.toDataURL(url);  // ✅ Return base64 for API response
}

module.exports = generateQR;
