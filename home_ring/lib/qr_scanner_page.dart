import 'package:flutter/material.dart';
import 'package:qr_code_scanner_plus/qr_code_scanner_plus.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';

class QrScannerPage extends StatefulWidget {
  const QrScannerPage({Key? key}) : super(key: key);

  @override
  State<QrScannerPage> createState() => _QrScannerPageState();
}

class _QrScannerPageState extends State<QrScannerPage> {
  final GlobalKey qrKey = GlobalKey(debugLabel: 'QR');
  QRViewController? controller;
  String? qrText;
  bool isProcessing = false;
  bool isActivated = false;

  @override
  void reassemble() {
    super.reassemble();
    if (controller != null) {
      controller!.pauseCamera();
      controller!.resumeCamera();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Colors.deepPurple,
        title: const Text('QR Code Scanner',
            style: TextStyle(color: Colors.white)),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.white),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: Column(
        children: <Widget>[
          Expanded(
            flex: 4,
            child: Container(
              margin: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(24),
                boxShadow: [
                  BoxShadow(
                    color: Colors.deepPurple.withOpacity(0.2),
                    blurRadius: 16,
                    offset: const Offset(0, 8),
                  ),
                ],
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(24),
                child: QRView(
                  key: qrKey,
                  onQRViewCreated: _onQRViewCreated,
                  overlay: QrScannerOverlayShape(
                    borderColor: Colors.deepPurple,
                    borderRadius: 16,
                    borderLength: 40,
                    borderWidth: 10,
                    cutOutSize: MediaQuery.of(context).size.width * 0.7,
                  ),
                ),
              ),
            ),
          ),
          Expanded(
            flex: 1,
            child: Center(
              child: isProcessing
                  ? const CircularProgressIndicator(color: Colors.deepPurple)
                  : isActivated
                      ? _buildActivatedUI()
                      : qrText != null
                          ? _buildQRDataUI()
                          : const Text('Scan a QR code to activate doorbell',
                              style: TextStyle(fontSize: 18)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildQRDataUI() {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const Text('QR Code Detected:',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        Text(qrText!,
            style: const TextStyle(fontSize: 16, color: Colors.deepPurple)),
        const SizedBox(height: 16),
        ElevatedButton.icon(
          style: ElevatedButton.styleFrom(
            backgroundColor: Colors.deepPurple,
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
          ),
          onPressed: _activateQR,
          icon: const Icon(Icons.doorbell, color: Colors.white),
          label: const Text('Activate Doorbell',
              style: TextStyle(color: Colors.white, fontSize: 16)),
        ),
      ],
    );
  }

  Widget _buildActivatedUI() {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const Icon(Icons.check_circle, color: Colors.green, size: 64),
        const SizedBox(height: 16),
        const Text('Doorbell Activated!',
            style: TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.bold,
                color: Colors.green)),
        const SizedBox(height: 8),
        const Text(
            'Your QR code is now active.\nVisitors can scan it to call you.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 14, color: Colors.grey)),
        const SizedBox(height: 16),
        ElevatedButton.icon(
          style: ElevatedButton.styleFrom(
            backgroundColor: Colors.deepPurple,
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
          ),
          onPressed: () {
            setState(() {
              qrText = null;
              isActivated = false;
            });
            controller?.resumeCamera();
          },
          icon: const Icon(Icons.refresh, color: Colors.white),
          label: const Text('Scan Another QR',
              style: TextStyle(color: Colors.white, fontSize: 16)),
        ),
      ],
    );
  }

  void _onQRViewCreated(QRViewController controller) {
    setState(() {
      this.controller = controller;
    });
    controller.scannedDataStream.listen((scanData) {
      if (!isProcessing && !isActivated) {
        setState(() {
          qrText = scanData.code;
        });
        controller.pauseCamera();
      }
    });
  }

  Future<void> _activateQR() async {
    if (qrText == null) return;

    setState(() {
      isProcessing = true;
    });

    try {
      final response = await http.post(
        Uri.parse('https://homering.onrender.com/api/door/activate'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({
          'doorID': qrText,
          'ownerID': 'user_123', // TODO: Get from Firebase Auth
          'phoneNumber': '+1234567890', // TODO: Get from user profile
        }),
      );

      if (response.statusCode == 200) {
        setState(() {
          isActivated = true;
          isProcessing = false;
        });

        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Doorbell activated successfully!'),
            backgroundColor: Colors.green,
          ),
        );
      } else {
        throw Exception('Failed to activate doorbell');
      }
    } catch (e) {
      setState(() {
        isProcessing = false;
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
  void dispose() {
    controller?.dispose();
    super.dispose();
  }
}
