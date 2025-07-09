import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'qr_scanner_page.dart';
import 'video_call_page.dart';
import 'doorbell_management_page.dart';

class DashboardPage extends StatelessWidget {
  const DashboardPage({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final user = FirebaseAuth.instance.currentUser;
    final userName =
        user?.displayName ?? user?.email?.split('@').first ?? 'User';
    return Scaffold(
      backgroundColor: const Color(0xFFF6F9FC),
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        leading: Padding(
          padding: const EdgeInsets.all(8.0),
          child: CircleAvatar(
            backgroundColor: Colors.blue.shade100,
            child: const Icon(Icons.person, color: Colors.blue, size: 28),
          ),
        ),
        title: Text('Hello, $userName!',
            style: const TextStyle(
                color: Colors.black, fontWeight: FontWeight.bold)),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings, color: Colors.blue),
            onPressed: () {
              // TODO: Navigate to settings
            },
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Live Door View Card
          Card(
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
            elevation: 4,
            child: Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 60,
                        height: 60,
                        decoration: BoxDecoration(
                          color: Colors.blue.shade50,
                          borderRadius: BorderRadius.circular(16),
                        ),
                        child: const Icon(Icons.videocam,
                            color: Colors.blue, size: 36),
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: const [
                            Text('Live Door View',
                                style: TextStyle(
                                    fontSize: 18, fontWeight: FontWeight.bold)),
                            SizedBox(height: 4),
                            Text('Status: Someone is at the door 🟢',
                                style: TextStyle(
                                    fontSize: 14, color: Colors.green)),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: [
                      ElevatedButton.icon(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.redAccent,
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12)),
                        ),
                        onPressed: () {
                          Navigator.push(
                            context,
                            MaterialPageRoute(
                              builder: (_) => VideoCallPage(
                                channelName: "doorbell_channel_1",
                                agoraAppId: "e99f68decc74469e93db09796e5ccd8c",
                                token: null,
                                isIncoming: false,
                              ),
                            ),
                          );
                        },
                        icon: const Icon(Icons.videocam, color: Colors.white),
                        label: const Text('Live Video',
                            style: TextStyle(color: Colors.white)),
                      ),
                      ElevatedButton.icon(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.blue,
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12)),
                        ),
                        onPressed: () {
                          // TODO: Open ring history
                        },
                        icon: const Icon(Icons.history, color: Colors.white),
                        label: const Text('Ring History',
                            style: TextStyle(color: Colors.white)),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          // Notifications Card
          Card(
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
            elevation: 2,
            child: Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Recent Notifications',
                      style:
                          TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 12),
                  ...[
                    _notificationTile(Icons.notifications_off,
                        'Missed ring at 12:45 PM', '10 mins ago'),
                    _notificationTile(Icons.visibility,
                        'Visitor detected at 9:30 AM', '3 hours ago'),
                    _notificationTile(Icons.door_front_door,
                        'Door opened by Mom at 8:10 AM', '4 hours ago'),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          // Add Family Member
          Card(
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
            color: Colors.blue.shade50,
            elevation: 0,
            child: ListTile(
              leading:
                  const Icon(Icons.person_add, color: Colors.blue, size: 32),
              title: const Text('Add Family Member',
                  style: TextStyle(fontWeight: FontWeight.bold)),
              onTap: () {
                // TODO: Navigate to user management
              },
              trailing: const Icon(Icons.arrow_forward_ios, color: Colors.blue),
            ),
          ),
          const SizedBox(height: 20),
          // QR Scanner Quick Action
          Card(
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
            color: Colors.deepPurple.shade50,
            elevation: 0,
            child: ListTile(
              leading: const Icon(Icons.qr_code_scanner,
                  color: Colors.deepPurple, size: 32),
              title: const Text('Scan QR Code',
                  style: TextStyle(fontWeight: FontWeight.bold)),
              onTap: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(builder: (_) => const QrScannerPage()),
                );
              },
              trailing:
                  const Icon(Icons.arrow_forward_ios, color: Colors.deepPurple),
            ),
          ),
          const SizedBox(height: 20),
          // My Doorbells Management
          Card(
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
            color: Colors.orange.shade50,
            elevation: 0,
            child: ListTile(
              leading:
                  const Icon(Icons.doorbell, color: Colors.orange, size: 32),
              title: const Text('My Doorbells',
                  style: TextStyle(fontWeight: FontWeight.bold)),
              onTap: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                      builder: (_) => const DoorbellManagementPage()),
                );
              },
              trailing:
                  const Icon(Icons.arrow_forward_ios, color: Colors.orange),
            ),
          ),
        ],
      ),
    );
  }

  static Widget _notificationTile(IconData icon, String title, String time) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6.0),
      child: Row(
        children: [
          Icon(icon, color: Colors.blue, size: 24),
          const SizedBox(width: 12),
          Expanded(child: Text(title, style: const TextStyle(fontSize: 16))),
          Text(time, style: const TextStyle(fontSize: 12, color: Colors.grey)),
        ],
      ),
    );
  }
}
