const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const doorRoutes = require("./routes/doorRoutes");

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from the visit directory
app.use(express.static(path.join(__dirname, "../visit")));

// API routes
app.use("/api/door", doorRoutes);

// Dynamic route for /:doorID (serves visitor page for any doorID)
app.get("/:doorID", (req, res) => {
  const htmlPath = path.join(__dirname, "../visit/index.html");
  fs.readFile(htmlPath, "utf8", (err, data) => {
    if (err) return res.status(500).send("Error loading page");
    // Optionally inject doorID into the HTML here
    res.send(data);
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
