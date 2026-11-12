import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart' hide Card;
import 'package:http/http.dart' as http;

import '../config_env.dart' as env;
import '../ui.dart';

/// Every request the network specs make. In e2e the DSN is the mock ingest on
/// :9393, and the echo sits on its sibling port :9394, because the SDK skips
/// requests to its own ingest.
///
/// The "fetch" buttons keep RN's labels, since the shared specs tap them by
/// text; here they go through package:http, Flutter's everyday client. The
/// dart:io and dio buttons each hit their own path, so a spec can tell which
/// client produced an event.
class NetworkScreen extends StatefulWidget {
  const NetworkScreen({super.key});

  @override
  State<NetworkScreen> createState() => _NetworkScreenState();
}

class _NetworkScreenState extends State<NetworkScreen> {
  var _last = '—';

  VoidCallback _withResult(String label, Future<Object?> Function() run) {
    return () async {
      setState(() => _last = '$label: …');
      try {
        final result = await run();
        if (!mounted) return;
        setState(
          () => _last = result is _Skipped
              ? '$label: skipped — ${result.reason}'
              : '$label: ok',
        );
      } catch (e) {
        if (!mounted) return;
        setState(() => _last = '$label: $e');
      }
    };
  }

  @override
  Widget build(BuildContext context) {
    final echo = env.echoUrl;
    return PageBody(
      children: [
        const PageTitle('Network'),
        const PageHint(
          'package:http, dart:io and dio are all captured through '
          'HttpOverrides. Inspect the echoed request to see the injected '
          '`traceparent`.',
        ),
        Card(
          children: [
            Button(
              label: 'fetch GET',
              testId: 'net-fetch-get',
              onPressed: _withResult('fetch', () => http.get(Uri.parse(echo))),
            ),
            Button(
              label: 'fetch POST',
              testId: 'net-fetch-post',
              onPressed: _withResult(
                'fetch-post',
                () => http.post(
                  Uri.parse(echo),
                  headers: {'content-type': 'application/json'},
                  body: jsonEncode({'hello': 'mobile'}),
                ),
              ),
            ),
            Button(
              label: 'dart:io GET',
              testId: 'net-dartio-get',
              onPressed: _withResult('dartio', () async {
                final client = HttpClient();
                try {
                  final request = await client.getUrl(
                    Uri.parse('$echo/dartio'),
                  );
                  final response = await request.close();
                  return await response.transform(utf8.decoder).join();
                } finally {
                  client.close();
                }
              }),
            ),
            Button(
              label: 'dio GET',
              testId: 'net-dio-get',
              onPressed: _withResult(
                'dio',
                () => Dio().get<Object?>('$echo/dio'),
              ),
            ),
            Button(
              label: 'abort in-flight',
              testId: 'net-abort',
              // Starts a request against the slow echo and aborts it before it
              // can answer. An aborted request must not be reported; the spec
              // pairs it with one that lands, so silence can't pass on its own.
              onPressed: _withResult('abort', () async {
                final client = HttpClient();
                try {
                  final request = await client.getUrl(
                    Uri.parse('$echo/slow?ms=5000'),
                  );
                  Timer(const Duration(milliseconds: 200), request.abort);
                  final response = await request.close();
                  return await response.drain<void>();
                } finally {
                  client.close();
                }
              }),
            ),
            Button(
              label: 'large response',
              testId: 'net-large-response',
              // Over 5 KB of JSON, past the SDK's response-body cap.
              onPressed: _withResult(
                'large',
                () => http.get(Uri.parse('$echo/large')),
              ),
            ),
            Button(
              label: 'failing request',
              testId: 'net-fail',
              // Loopback port 1 refuses at once on both platforms: a fast,
              // deterministic failure, captured as status 0.
              onPressed: _withResult(
                'fail',
                () => http.get(Uri.parse('http://127.0.0.1:1/unreachable')),
              ),
            ),
            Button(
              label: 'sensitive request',
              testId: 'net-sensitive',
              // A secret in each place the SDK redacts on its own (query,
              // header, body) plus two values that must survive. Local mock
              // only: a real DSN's fallback echo is public and echoes back.
              onPressed: _withResult(
                'sensitive',
                () async => !env.echoIsLocalMock
                    ? const _Skipped('local-mock only; the echo is public here')
                    : http.post(
                        Uri.parse(
                          '$echo/sensitive?token=e2e-query-token&user=demo',
                        ),
                        headers: {
                          'content-type': 'application/json',
                          'authorization': 'Bearer e2e-bearer-secret',
                        },
                        body: jsonEncode({
                          'password': 'e2e-body-password',
                          'email': 'demo@example.com',
                          'order_id': 'A-1',
                        }),
                      ),
              ),
            ),
            Text('Last: $_last'),
          ],
        ),
      ],
    );
  }
}

/// A button that declined to act. Reported as a skip, never as `ok`, so a
/// tester can't mistake it for a request that ran.
final class _Skipped {
  const _Skipped(this.reason);

  final String reason;
}
