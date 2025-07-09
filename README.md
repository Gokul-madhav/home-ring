# QR Doorbell System with Agora Video Calling

A complete QR doorbell system that allows visitors to scan a QR code and make video calls to homeowners through their browser, while homeowners receive calls in the Flutter mobile app.

## Features

- **QR Code Activation**: Homeowners can scan QR codes to activate them as their doorbells
- **Visitor Web Interface**: Visitors can scan QR codes and use their browser for video calls
- **Mobile App**: Flutter app for homeowners to receive and manage video calls
- **Real-time Video Calling**: Powered by Agora RTC for high-quality video communication
- **Call Management**: Accept, reject, and manage incoming calls
- **Doorbell Management**: View and manage all activated doorbells

## System Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Visitor       │    │   Backend       │    │   Flutter App   │
│   Browser       │◄──►│   Server        │◄──►│   (Homeowner)   │
│                 │    │                 │    │                 │
│ - Scan QR Code  │    │ - QR Generation │    │ - Receive Calls │
│ - Video Call    │    │ - Call Routing  │    │ - Manage Doorbells│
│ - Agora RTC     │    │ - Firebase DB   │    │ - Accept/Reject │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Prerequisites

- Node.js (v16 or higher)
- Flutter SDK (v3.0 or higher)
- Agora.io account and App ID
- Firebase project with Realtime Database
- Android Studio / Xcode (for mobile development)

## Setup Instructions

### 1. Backend Setup

1. Navigate to the backend directory:
   ```bash
   cd qr-doorbell-backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure Firebase:
   - Place your Firebase service account key in `serviceAccountKey.json`
   - Update Firebase configuration in `firebase.js`

4. Configure Agora:
   - Update `AGORA_APP_ID` in `routes/doorRoutes.js` with your Agora App ID
   - Add your Agora App Certificate for token generation

5. Start the servers:
   ```bash
   # Start both main server and visitor server
   npm run dev:all
   
   # Or start them separately:
   npm run dev          # Main server on port 5000
   npm run dev:visitor  # Visitor server on port 3000
   ```

### 2. Flutter App Setup

1. Navigate to the Flutter app directory:
   ```bash
   cd home_ring
   ```

2. Install dependencies:
   ```bash
   flutter pub get
   ```

3. Configure Firebase:
   - Add your `google-services.json` (Android) and `GoogleService-Info.plist` (iOS)
   - Update Firebase configuration in `firebase_options.dart`

4. Configure Agora:
   - Update the Agora App ID in `video_call_page.dart` and `dashboard_page.dart`

5. Run the app:
   ```bash
   flutter run
   ```

## Usage Guide

### For Homeowners (Flutter App)

1. **Activate a QR Code**:
   - Open the app and go to Dashboard
   - Tap "Scan QR Code"
   - Scan a QR code sticker
   - Tap "Activate Doorbell"

2. **Manage Doorbells**:
   - Go to "My Doorbells" from Dashboard
   - View all activated doorbells
   - Test calls, deactivate, or delete doorbells

3. **Receive Calls**:
   - When a visitor rings, you'll get an incoming call notification
   - Accept or reject the call
   - Use video controls during the call

### For Visitors (Web Browser)

1. **Scan QR Code**:
   - Use any QR code scanner app
   - Scan the QR code sticker at the door
   - The browser will open automatically

2. **Make a Call**:
   - Enter your name
   - Tap "Ring Doorbell"
   - Wait for the homeowner to answer

3. **Video Call**:
   - Use video and audio controls
   - End call when finished

## API Endpoints

### Doorbell Management
- `POST /api/door/generate` - Generate new QR code
- `POST /api/door/activate` - Activate QR code for doorbell
- `GET /api/door/my-doorbells` - Get user's doorbells
- `POST /api/door/deactivate` - Deactivate doorbell
- `DELETE /api/door/:doorID` - Delete doorbell

### Video Calling
- `POST /api/door/call/:doorID` - Initiate video call
- `GET /api/door/call/:callID/status` - Get call status
- `POST /api/door/call/:callID/accept` - Accept call
- `POST /api/door/call/:callID/end` - End call

## Configuration

### Environment Variables
- `PORT` - Main server port (default: 5000)
- `VISITOR_PORT` - Visitor server port (default: 3000)
- `AGORA_APP_ID` - Your Agora App ID
- `AGORA_APP_CERTIFICATE` - Your Agora App Certificate

### Firebase Configuration
The system uses Firebase Realtime Database with the following structure:
```
/doors/{doorID} - Doorbell information
/users/{userID}/doorbells/{doorID} - User's doorbells
/calls/{callID} - Call information
```

## Security Considerations

1. **Agora Token Generation**: Implement proper token generation for production
2. **Authentication**: Add user authentication to the Flutter app
3. **HTTPS**: Use HTTPS in production for secure communication
4. **Rate Limiting**: Implement rate limiting for API endpoints
5. **Input Validation**: Validate all user inputs

## Troubleshooting

### Common Issues

1. **Video not working**:
   - Check camera permissions
   - Verify Agora App ID is correct
   - Ensure internet connection is stable

2. **QR codes not scanning**:
   - Verify QR code URL is accessible
   - Check visitor server is running
   - Ensure proper URL encoding

3. **Calls not connecting**:
   - Check both servers are running
   - Verify Firebase connection
   - Check Agora credentials

### Debug Mode

Enable debug logging by setting environment variables:
```bash
DEBUG=* npm run dev:all
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support and questions:
- Create an issue in the repository
- Check the troubleshooting section
- Review Agora and Firebase documentation 