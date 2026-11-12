// A minimal app with groundcover RUM: init awaited before runApp, the widget
// around the app, and the navigator observer. "Before you start" in the
// package README says where the config's values come from.
import 'package:flutter/material.dart';
import 'package:groundcover_rum/groundcover_rum.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await GroundcoverRum.init(
      const GroundcoverConfig(
        apiKey: 'your-rum-ingestion-key',
        dsn: 'https://example.platform.grcv.io',
        cluster: 'your-cluster',
        environment: 'production',
        appId: 'groundcover-example',
        releaseId: '1.0.0',
        options: GroundcoverOptions(
          // Distributed-tracing headers on requests to your own API.
          tracing: TracingOptions(
            propagationUrls: ['https://api.example.com/*'],
          ),
        ),
      ),
    );
  } on GroundcoverInitException catch (error) {
    // The SDK couldn't start, and the app runs unmonitored.
    debugPrint('groundcover: $error');
  }
  runApp(const GroundcoverWidget(child: ExampleApp()));
}

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'groundcover example',
    navigatorObservers: [GroundcoverNavigatorObserver()],
    routes: {'/': (_) => const HomeScreen()},
  );
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Home')),
    body: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          FilledButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                // A pushed route needs a name to be tracked as a screen.
                settings: const RouteSettings(name: 'Checkout'),
                builder: (_) => const CheckoutScreen(),
              ),
            ),
            child: const Text('Checkout'),
          ),
          TextButton(
            onPressed: () {
              GroundcoverRum.identifyUser(const RumUser(id: 'u_123'));
              GroundcoverRum.sendCustomEvent('signed_in', {'method': 'demo'});
            },
            child: const Text('Sign in'),
          ),
        ],
      ),
    ),
  );
}

class CheckoutScreen extends StatelessWidget {
  const CheckoutScreen({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Checkout')),
    body: Center(
      child: FilledButton(
        onPressed: () {
          try {
            throw StateError('card declined');
          } catch (error, stackTrace) {
            GroundcoverRum.captureException(
              error,
              stackTrace: stackTrace,
              metadata: {'step': 'payment'},
            );
          }
        },
        child: const Text('Pay'),
      ),
    ),
  );
}
