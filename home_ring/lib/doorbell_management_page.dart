import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'video_call_page.dart';

class DoorbellManagementPage extends StatefulWidget {
  const DoorbellManagementPage({Key? key}) : super(key: key);

  @override
  State<DoorbellManagementPage> createState() => _DoorbellManagementPageState();
}

class _DoorbellManagementPageState extends State<DoorbellManagementPage> {
  List<Map<String, dynamic>> doorbells = [];
  bool isLoading = true;

  @override
  void initState() {
    super.initState();
    _loadDoorbells();
  }

  Future<void> _loadDoorbells() async {
    try {
      final response = await http.get(
        Uri.parse('http://localhost:5000/api/door/my-doorbells'),
        headers: {'Content-Type': 'application/json'},
      );

      if (response.statusCode == 200) {
        final data = json.decode(response.body);
        setState(() {
          doorbells = List<Map<String, dynamic>>.from(data['doorbells']);
          isLoading = false;
        });
      } else {
        throw Exception('Failed to load doorbells');
      }
    } catch (e) {
      setState(() {
        isLoading = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Error: ${e.toString()}'),
          backgroundColor: Colors.red,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF6F9FC),
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        title: const Text('My Doorbells',
            style: TextStyle(color: Colors.black, fontWeight: FontWeight.bold)),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.black),
          onPressed: () => Navigator.of(context).pop(),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: Colors.blue),
            onPressed: _loadDoorbells,
          ),
        ],
      ),
      body: isLoading
          ? const Center(child: CircularProgressIndicator())
          : doorbells.isEmpty
              ? _buildEmptyState()
              : ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: doorbells.length,
                  itemBuilder: (context, index) {
                    final doorbell = doorbells[index];
                    return _buildDoorbellCard(doorbell);
                  },
                ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.doorbell_outlined, size: 80, color: Colors.grey.shade400),
          const SizedBox(height: 16),
          Text('No doorbells activated yet',
              style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: Colors.grey.shade600)),
          const SizedBox(height: 8),
          Text('Scan a QR code to activate your first doorbell',
              style: TextStyle(fontSize: 14, color: Colors.grey.shade500)),
          const SizedBox(height: 24),
          ElevatedButton.icon(
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.deepPurple,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12)),
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
            ),
            onPressed: () {
              Navigator.pushNamed(context, '/qr-scanner');
            },
            icon: const Icon(Icons.qr_code_scanner, color: Colors.white),
            label: const Text('Scan QR Code',
                style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );
  }

  Widget _buildDoorbellCard(Map<String, dynamic> doorbell) {
    final isActive = doorbell['status'] == 'active';
    final lastActivity = doorbell['lastActivity'] != null
        ? DateTime.parse(doorbell['lastActivity'])
        : null;

    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      elevation: 4,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 50,
                  height: 50,
                  decoration: BoxDecoration(
                    color:
                        isActive ? Colors.green.shade50 : Colors.grey.shade50,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(
                    Icons.doorbell,
                    color: isActive ? Colors.green : Colors.grey,
                    size: 28,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Doorbell ${doorbell['doorID'].substring(0, 8)}...',
                        style: const TextStyle(
                            fontSize: 16, fontWeight: FontWeight.bold),
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          Container(
                            width: 8,
                            height: 8,
                            decoration: BoxDecoration(
                              color: isActive ? Colors.green : Colors.grey,
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 6),
                          Text(
                            isActive ? 'Active' : 'Inactive',
                            style: TextStyle(
                                fontSize: 12,
                                color: isActive ? Colors.green : Colors.grey),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                PopupMenuButton<String>(
                  onSelected: (value) => _handleMenuAction(value, doorbell),
                  itemBuilder: (context) => [
                    const PopupMenuItem(
                      value: 'deactivate',
                      child: Row(
                        children: [
                          Icon(Icons.power_settings_new, color: Colors.red),
                          SizedBox(width: 8),
                          Text('Deactivate'),
                        ],
                      ),
                    ),
                    const PopupMenuItem(
                      value: 'delete',
                      child: Row(
                        children: [
                          Icon(Icons.delete, color: Colors.red),
                          SizedBox(width: 8),
                          Text('Delete'),
                        ],
                      ),
                    ),
                  ],
                ),
              ],
            ),
            if (lastActivity != null) ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  Icon(Icons.access_time,
                      size: 16, color: Colors.grey.shade600),
                  const SizedBox(width: 6),
                  Text(
                    'Last activity: ${_formatDateTime(lastActivity)}',
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.blue,
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(8)),
                      padding: const EdgeInsets.symmetric(vertical: 8),
                    ),
                    onPressed: () => _testDoorbell(doorbell),
                    icon: const Icon(Icons.videocam,
                        color: Colors.white, size: 18),
                    label: const Text('Test Call',
                        style: TextStyle(color: Colors.white, fontSize: 12)),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.deepPurple,
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(8)),
                      padding: const EdgeInsets.symmetric(vertical: 8),
                    ),
                    onPressed: () => _showQRCode(doorbell),
                    icon: const Icon(Icons.qr_code,
                        color: Colors.white, size: 18),
                    label: const Text('Show QR',
                        style: TextStyle(color: Colors.white, fontSize: 12)),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  String _formatDateTime(DateTime dateTime) {
    final now = DateTime.now();
    final difference = now.difference(dateTime);

    if (difference.inDays > 0) {
      return '${difference.inDays} days ago';
    } else if (difference.inHours > 0) {
      return '${difference.inHours} hours ago';
    } else if (difference.inMinutes > 0) {
      return '${difference.inMinutes} minutes ago';
    } else {
      return 'Just now';
    }
  }

  void _handleMenuAction(String action, Map<String, dynamic> doorbell) async {
    switch (action) {
      case 'deactivate':
        await _deactivateDoorbell(doorbell['doorID']);
        break;
      case 'delete':
        await _deleteDoorbell(doorbell['doorID']);
        break;
    }
  }

  Future<void> _deactivateDoorbell(String doorID) async {
    try {
      final response = await http.post(
        Uri.parse('http://localhost:5000/api/door/deactivate'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'doorID': doorID}),
      );

      if (response.statusCode == 200) {
        _loadDoorbells();
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Doorbell deactivated'),
            backgroundColor: Colors.orange,
          ),
        );
      } else {
        throw Exception('Failed to deactivate doorbell');
      }
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Error: ${e.toString()}'),
          backgroundColor: Colors.red,
        ),
      );
    }
  }

  Future<void> _deleteDoorbell(String doorID) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete Doorbell'),
        content: const Text(
            'Are you sure you want to delete this doorbell? This action cannot be undone.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Delete'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    try {
      final response = await http.delete(
        Uri.parse('http://localhost:5000/api/door/$doorID'),
        headers: {'Content-Type': 'application/json'},
      );

      if (response.statusCode == 200) {
        _loadDoorbells();
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Doorbell deleted'),
            backgroundColor: Colors.red,
          ),
        );
      } else {
        throw Exception('Failed to delete doorbell');
      }
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Error: ${e.toString()}'),
          backgroundColor: Colors.red,
        ),
      );
    }
  }

  void _testDoorbell(Map<String, dynamic> doorbell) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => VideoCallPage(
          channelName: "test_${doorbell['doorID']}",
          agoraAppId: "e99f68decc74469e93db09796e5ccd8c",
          token: null,
          isIncoming: false,
        ),
      ),
    );
  }

  void _showQRCode(Map<String, dynamic> doorbell) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('QR Code'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Scan this QR code to call this doorbell:'),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                border: Border.all(color: Colors.grey.shade300),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                doorbell['doorID'],
                style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }
}
