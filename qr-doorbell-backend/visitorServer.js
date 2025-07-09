const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.VISITOR_PORT || 3000;

// Enable CORS
app.use(cors());

// Serve static files from the visit directory
app.use(express.static(path.join(__dirname, '../visit')));

// Route to serve the visitor page
app.get('/:doorID', (req, res) => {
  const doorID = req.params.doorID;
  
  // Read the HTML file and inject the door ID
  const fs = require('fs');
  const htmlPath = path.join(__dirname, '../visit/index.html');
  
  fs.readFile(htmlPath, 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading HTML file:', err);
      return res.status(500).send('Error loading page');
    }
    
    // Inject the door ID into the URL
    const modifiedHtml = data.replace(
      'const doorID = urlParams.get(\'door\');',
      `const doorID = '${doorID}';`
    );
    
    res.send(modifiedHtml);
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'visitor-server' });
});

app.listen(PORT, () => {
  console.log(`Visitor server running on port ${PORT}`);
  console.log(`Access visitor interface at: http://localhost:${PORT}/[doorID]`);
});

module.exports = app; 