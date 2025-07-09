import 'package:flutter/material.dart';
import 'package:agora_rtc_engine/agora_rtc_engine.dart';
import 'package:audioplayers/audioplayers.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';

class VideoCallPage extends StatefulWidget {
  final String channelName;
  final String agoraAppId;
  final String? token;
  final bool isIncoming;
  final String? callID;
  final String? visitorName;

  const VideoCallPage({
    Key? key,
    required this.channelName,
    required this.agoraAppId,
    this.token,
    this.isIncoming = false,
    this.callID,
    this.visitorName,
  }) : super(key: key);

  @override
  State<VideoCallPage> createState() => _VideoCallPageState();
}

class _VideoCallPageState extends State<VideoCallPage> {
  late RtcEngine _engine;
  bool _joined = false;
  int? _remoteUid;
  bool _videoEnabled = true;
  bool _audioEnabled = true;
  bool _showIncoming = false;
  AudioPlayer? _audioPlayer;
  String _callStatus = 'connecting';

  @override
  void initState() {
    super.initState();
    _showIncoming = widget.isIncoming;
    if (_showIncoming) {
      _playRingtone();
      _showIncomingCallDialog();
    } else {
      _initAgora();
    }
  }

  Future<void> _playRingtone() async {
    _audioPlayer = AudioPlayer();
    // Note: You'll need to add a ringtone.mp3 file to your assets
    // await _audioPlayer!.play(AssetSource('assets/ringtone.mp3'), volume: 1.0);
  }

  Future<void> _stopRingtone() async {
    await _audioPlayer?.stop();
    _audioPlayer?.dispose();
  }

  void _showIncomingCallDialog() {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        backgroundColor: Colors.black87,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.videocam, color: Colors.white, size: 64),
            const SizedBox(height: 16),
            Text(
              'Incoming Video Call',
              style: const TextStyle(
                color: Colors.white,
                fontSize: 24,
                fontWeight: FontWeight.bold,
              ),
            ),
            if (widget.visitorName != null) ...[
              const SizedBox(height: 8),
              Text(
                'From: ${widget.visitorName}',
                style: const TextStyle(
                  color: Colors.white70,
                  fontSize: 16,
                ),
              ),
            ],
            const SizedBox(height: 24),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                ElevatedButton.icon(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.green,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16)),
                    padding: const EdgeInsets.symmetric(
                        horizontal: 24, vertical: 12),
                  ),
                  onPressed: _acceptCall,
                  icon: const Icon(Icons.call, color: Colors.white),
                  label: const Text('Accept',
                      style: TextStyle(color: Colors.white)),
                ),
                ElevatedButton.icon(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.red,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16)),
                    padding: const EdgeInsets.symmetric(
                        horizontal: 24, vertical: 12),
                  ),
                  onPressed: _rejectCall,
                  icon: const Icon(Icons.call_end, color: Colors.white),
                  label: const Text('Reject',
                      style: TextStyle(color: Colors.white)),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _initAgora() async {
    _engine = createAgoraRtcEngine();
    await _engine.initialize(RtcEngineContext(appId: widget.agoraAppId));
    _engine.registerEventHandler(
      RtcEngineEventHandler(
        onJoinChannelSuccess: (connection, elapsed) {
          setState(() => _joined = true);
          _updateCallStatus('connected');
        },
        onUserJoined: (connection, remoteUid, elapsed) {
          setState(() => _remoteUid = remoteUid);
          _updateCallStatus('connected');
        },
        onUserOffline: (connection, remoteUid, reason) {
          setState(() => _remoteUid = null);
          _updateCallStatus('disconnected');
        },
        onConnectionLost: (connection) {
          _updateCallStatus('disconnected');
        },
      ),
    );
    await _engine.enableVideo();
    await _engine.joinChannel(
      token: widget.token ?? "",
      channelId: widget.channelName,
      uid: 0,
      options: const ChannelMediaOptions(),
    );
  }

  void _updateCallStatus(String status) {
    setState(() {
      _callStatus = status;
    });
  }

  @override
  void dispose() {
    _engine.leaveChannel();
    _engine.release();
    _stopRingtone();
    super.dispose();
  }

  void _acceptCall() async {
    await _stopRingtone();
    setState(() => _showIncoming = false);

    if (widget.callID != null) {
      try {
        await http.post(
          Uri.parse(
              'https://homering.onrender.com/api/door/call/${widget.callID}/accept'),
          headers: {'Content-Type': 'application/json'},
        );
      } catch (e) {
        print('Error accepting call: $e');
      }
    }

    Navigator.of(context).pop(); // Close dialog
    _initAgora();
  }

  void _rejectCall() async {
    await _stopRingtone();
    if (widget.callID != null) {
      try {
        await http.post(
          Uri.parse(
              'https://homering.onrender.com/api/door/call/${widget.callID}/end'),
          headers: {'Content-Type': 'application/json'},
        );
      } catch (e) {
        print('Error rejecting call: $e');
      }
    }
    Navigator.of(context).pop();
  }

  void _toggleVideo() {
    setState(() => _videoEnabled = !_videoEnabled);
    _engine.muteLocalVideoStream(!_videoEnabled);
  }

  void _toggleAudio() {
    setState(() => _audioEnabled = !_audioEnabled);
    _engine.muteLocalAudioStream(!_audioEnabled);
  }

  void _endCall() async {
    if (widget.callID != null) {
      try {
        await http.post(
          Uri.parse(
              'https://homering.onrender.com/api/door/call/${widget.callID}/end'),
          headers: {'Content-Type': 'application/json'},
        );
      } catch (e) {
        print('Error ending call: $e');
      }
    }
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          if (!_showIncoming && _joined)
            _remoteUid != null
                ? AgoraVideoView(
                    controller: VideoViewController.remote(
                      rtcEngine: _engine,
                      canvas: VideoCanvas(uid: _remoteUid),
                      connection: RtcConnection(channelId: widget.channelName),
                    ),
                  )
                : _buildWaitingScreen(),
          if (!_showIncoming && _joined)
            Align(
              alignment: Alignment.topLeft,
              child: SafeArea(
                child: Container(
                  margin: const EdgeInsets.all(16),
                  width: 120,
                  height: 180,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: Colors.white, width: 2),
                  ),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(10),
                    child: AgoraVideoView(
                      controller: VideoViewController(
                        rtcEngine: _engine,
                        canvas: const VideoCanvas(uid: 0),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          if (!_showIncoming && _joined) _buildCallControls(),
          if (_callStatus != 'connected' && !_showIncoming)
            _buildStatusOverlay(),
        ],
      ),
    );
  }

  Widget _buildWaitingScreen() {
    return Container(
      color: Colors.black,
      child: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.videocam, color: Colors.white, size: 64),
            const SizedBox(height: 16),
            Text(
              _callStatus == 'connecting'
                  ? 'Connecting...'
                  : 'Waiting for visitor...',
              style: const TextStyle(
                color: Colors.white,
                fontSize: 18,
              ),
            ),
            const SizedBox(height: 16),
            const CircularProgressIndicator(color: Colors.white),
          ],
        ),
      ),
    );
  }

  Widget _buildStatusOverlay() {
    return Container(
      color: Colors.black54,
      child: Center(
        child: Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                _callStatus == 'disconnected'
                    ? Icons.signal_wifi_off
                    : Icons.sync,
                size: 48,
                color: _callStatus == 'disconnected' ? Colors.red : Colors.blue,
              ),
              const SizedBox(height: 16),
              Text(
                _callStatus == 'disconnected'
                    ? 'Connection Lost'
                    : 'Connecting...',
                style: const TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                _callStatus == 'disconnected'
                    ? 'The call has been disconnected'
                    : 'Please wait while we connect you',
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.grey),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildCallControls() {
    return Align(
      alignment: Alignment.bottomCenter,
      child: Container(
        margin: const EdgeInsets.all(20),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        decoration: BoxDecoration(
          color: Colors.black54,
          borderRadius: BorderRadius.circular(25),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _buildControlButton(Icons.videocam, _videoEnabled, _toggleVideo),
            const SizedBox(width: 20),
            _buildControlButton(Icons.mic, _audioEnabled, _toggleAudio),
            const SizedBox(width: 20),
            _buildControlButton(Icons.call_end, true, _endCall,
                isEndCall: true),
          ],
        ),
      ),
    );
  }

  Widget _buildControlButton(
      IconData icon, bool enabled, VoidCallback onPressed,
      {bool isEndCall = false}) {
    return GestureDetector(
      onTap: onPressed,
      child: Container(
        width: 50,
        height: 50,
        decoration: BoxDecoration(
          color: isEndCall
              ? Colors.red
              : enabled
                  ? Colors.white
                  : Colors.grey,
          shape: BoxShape.circle,
        ),
        child: Icon(
          icon,
          color: isEndCall
              ? Colors.white
              : enabled
                  ? Colors.black
                  : Colors.white,
          size: 24,
        ),
      ),
    );
  }
}
