/// groundcover Real User Monitoring (RUM) for Flutter.
///
/// ```dart
/// Future<void> main() async {
///   WidgetsFlutterBinding.ensureInitialized();
///   try {
///     await GroundcoverRum.init(const GroundcoverConfig(
///       apiKey: 'your-rum-ingestion-key',
///       dsn: 'https://example.platform.grcv.io',
///       cluster: 'your-cluster',
///       environment: 'production',
///       appId: 'my-app',
///     ));
///   } on GroundcoverInitException catch (error) {
///     // The SDK couldn't start, and the app runs unmonitored.
///     debugPrint('groundcover: $error');
///   }
///   runApp(const GroundcoverWidget(child: MyApp()));
/// }
/// ```
///
/// Add a `GroundcoverNavigatorObserver` to the app's navigator for
/// navigation events. Screens are named by `RouteSettings.name`, so a route
/// pushed directly needs one to be tracked.
library;

export 'src/api/groundcover_rum.dart' show GroundcoverRum, RumLogger;
export 'src/api/init_exception.dart' show GroundcoverInitException;
export 'src/api/navigator_observer.dart' show GroundcoverNavigatorObserver;
export 'src/api/widgets.dart' show GroundcoverPrivate, GroundcoverWidget;
export 'src/core/config/types.dart'
    show
        BeforeSend,
        EnrichEvent,
        GroundcoverConfig,
        GroundcoverConfigUpdate,
        GroundcoverOptions,
        GroundcoverOptionsUpdate,
        HangThreshold,
        NativeOptions,
        PrivacyLevel,
        PrivacyOptions,
        RedactField,
        RedactKind,
        Redactor,
        RumEventName,
        RumUser,
        RuntimeOptions,
        TracingOptions,
        TracingOrigin,
        TransportOptions,
        TtiMode;
export 'src/core/events/rum_event.dart' show RumEvent;
