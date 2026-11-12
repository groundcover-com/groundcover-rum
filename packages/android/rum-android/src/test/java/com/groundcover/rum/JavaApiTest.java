package com.groundcover.rum;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.view.View;
import androidx.test.core.app.ApplicationProvider;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

// The public API as a Java app calls it: static methods, builders, and no Kotlin defaults to lean
// on. Mostly a compile check, like PublicApiTest.
@RunWith(RobolectricTestRunner.class)
public class JavaApiTest {
    private final Application app = ApplicationProvider.getApplicationContext();

    @After
    public void stopTheSdk() {
        GroundcoverRumTesting.reset();
    }

    @Test
    public void theQuickStartStarts() throws GroundcoverInitException {
        Groundcover.start(
                app,
                new GroundcoverConfig.Builder(
                                "your-rum-ingestion-key",
                                "https://example.platform.grcv.io",
                                "your-cluster",
                                "production",
                                "my-android-app")
                        .build());
    }

    @Test
    public void aBlankAppIdFailsTheStart() {
        GroundcoverConfig config =
                new GroundcoverConfig.Builder("key", "localhost:9393", "c", "dev", " ").build();
        GroundcoverInitException error =
                assertThrows(GroundcoverInitException.class, () -> Groundcover.start(app, config));
        assertEquals("start requires a nonblank appId", error.getMessage());
    }

    // Java reaches the full constructors, where null is the natural way to say "the default" and
    // nothing stops it in a Kotlin non-null slot. A null options or hooks starts the SDK with the
    // defaults, sampled launches included, which arm the hooks.
    @Test
    public void nullOptionsAndHooksFromJavaStartWithTheDefaults() throws GroundcoverInitException {
        GroundcoverOptions options =
                new GroundcoverOptions(
                        null, null, null, null, null, null, null, null, null, null, null, null,
                        null, null);
        Groundcover.start(
                app,
                new GroundcoverConfig(
                        "key", "localhost:9393", "c", "dev", "app", null, null, null, null,
                        options));
        assertTrue(options.getHooks().getActivities());
        GroundcoverRumTesting.reset();
        GroundcoverConfig noOptions =
                new GroundcoverConfig(
                        "key", "localhost:9393", "c", "dev", "app", null, null, null, null, null);
        Groundcover.start(app, noOptions);
        assertTrue(noOptions.getOptions().getHooks().getFragments());
    }

    // An invalid start is the one throw the API makes, and it is always GroundcoverInitException.
    @Test
    public void aNullContextOrConfigFailsTheStart() {
        GroundcoverConfig config =
                new GroundcoverConfig.Builder("key", "localhost:9393", "c", "dev", "app").build();
        assertThrows(GroundcoverInitException.class, () -> Groundcover.start(null, config));
        assertThrows(GroundcoverInitException.class, () -> Groundcover.start(app, null));
        assertThrows(
                GroundcoverInitException.class,
                () ->
                        Groundcover.start(
                                app,
                                new GroundcoverConfig(
                                        "key", "localhost:9393", "c", "dev", null, null, null,
                                        null, null, null)));
    }

    @Test
    public void everyOptionCanBeSet() throws GroundcoverInitException {
        GroundcoverOptions options =
                new GroundcoverOptions.Builder()
                        .enabledEvents(Arrays.asList(RumEventName.INTERACTION, RumEventName.CRASHES))
                        .sessionSampleRate(1)
                        .sessionMaxDurationMs(7_200_000)
                        .debug(true)
                        .excludedUrls(
                                Arrays.asList(
                                        UrlPattern.of("https://api.example.com/health"),
                                        UrlPattern.of(Pattern.compile("/metrics$"))))
                        .beforeSend(event -> !event.getType().equals("log"))
                        .enrichEvent(
                                event -> {
                                    event.getAttributes().put("team", "payments");
                                    return event;
                                })
                        .privacy(
                                new PrivacyOptions.Builder()
                                        .level(PrivacyLevel.MASK_ALL)
                                        .maskNetworkBodies(false)
                                        .sensitiveKeys(Collections.singletonList("order_id"))
                                        .redact(field -> field.getKey().equals("email") ? "x" : null)
                                        .build())
                        .tracing(
                                new TracingOptions.Builder()
                                        .propagationUrls(Collections.singletonList("https://api.myapp.com/*"))
                                        .origin(new TracingOrigin("origin", "rum"))
                                        .build())
                        .transport(
                                new TransportOptions.Builder()
                                        .batchSize(20)
                                        .batchTimeoutMs(5_000)
                                        .compression(true)
                                        .build())
                        .appVersion("1.2.3")
                        .appBuild("45")
                        .nativeOptions(
                                new NativeOptions.Builder()
                                        .hangThresholdMs(1_000)
                                        .vitalsMaxSegmentMs(30_000)
                                        .tti(TtiMode.MANUAL)
                                        .build())
                        .hooks(new NativeHooks.Builder().fragments(false).textFields(false).build())
                        .build();
        Groundcover.start(
                app,
                new GroundcoverConfig.Builder("key", "localhost:9393", "c", "dev", "app")
                        .namespace("ns")
                        .releaseId("1.0.0")
                        .user(new RumUser.Builder().id("u_123").email("demo@example.com").build())
                        .sessionId("fixed")
                        .options(options)
                        .build());
    }

    @Test
    public void everyCallIsAvailable() {
        Groundcover.identifyUser(
                new RumUser.Builder()
                        .id("u_123")
                        .properties(Collections.singletonMap("plan", "pro"))
                        .build());
        Groundcover.updateConfig(new GroundcoverConfigUpdate.Builder().user(UserUpdate.clear()).build());
        Groundcover.updateConfig(
                new GroundcoverConfigUpdate.Builder()
                        .user(UserUpdate.set(new RumUser.Builder().id("u_456").build()))
                        .options(new GroundcoverOptionsUpdate.Builder().debug(false).build())
                        .build());
        Groundcover.sendCustomEvent("plan_upgraded", Collections.singletonMap("plan", "pro"));
        Groundcover.sendCustomEvent("opened");
        Groundcover.captureException(new IllegalStateException("declined"));
        Groundcover.captureException(
                new IllegalStateException("declined"), Collections.singletonMap("step", "pay"));
        Groundcover.getLogger().warn("Payment retry", Collections.singletonMap("attempt", 2));
        Groundcover.getLogger().info("info");
        assertEquals("", Groundcover.getSessionId());
        Groundcover.setSessionId("fixed", () -> {});
        Groundcover.setSessionId();
        Groundcover.startNavigation("Checkout");
        Groundcover.startNavigation("Checkout", "checkout-1", Collections.singletonMap("cart", 3));
        Groundcover.endNavigation();
        Groundcover.stopNavigationTracking();
        Groundcover.markAppInteractive();
        GroundcoverRumTesting.forgetSession(app);
    }

    // Plain int literals reach the Builders' number setters, as Java writes them.
    @Test
    public void buildersTakeIntLiterals() {
        new TransportOptions.Builder().batchSize(20).batchTimeoutMs(5000).compression(true).build();
        new NativeOptions.Builder().hangThresholdMs(1000).vitalsMaxSegmentMs(30000).build();
        new GroundcoverOptions.Builder().sessionSampleRate(1).sessionMaxDurationMs(60000).build();
    }

    // No call but start throws into the app: a null from Java, where Kotlin's types can't stop
    // one, is the SDK's to handle.
    @Test
    public void nullsFromJavaNeverThrow() {
        Groundcover.identifyUser(null);
        Groundcover.updateConfig(null);
        Groundcover.sendCustomEvent(null);
        Groundcover.sendCustomEvent(null, null);
        Groundcover.captureException(null);
        Groundcover.captureException(null, null);
        Groundcover.getLogger().error(null);
        Groundcover.getLogger().info(null, null);
        Groundcover.setSessionId(null, null);
        Groundcover.startNavigation(null);
        Groundcover.startNavigation(null, null, null);
        Groundcover.endNavigation(null);
    }

    // The same, with the SDK running: a null reaches the core thread, which must not throw either.
    // The runtime swallows a throw there, so what proves it is the two log lines landing.
    @Test
    public void nullsFromJavaNeverThrowOnceStarted() {
        List<Map<String, Object>> sent =
                JavaApiHarness.sentWhileRunning(app, this::nullsFromJavaNeverThrow);
        List<String> logs = new ArrayList<>();
        for (Map<String, Object> event : sent) {
            Map<?, ?> attributes = (Map<?, ?>) event.get("attributes");
            logs.add(
                    event.get("type") + " " + attributes.get("level") + " '"
                            + attributes.get("message") + "'");
        }
        assertEquals(Arrays.asList("log error ''", "log info ''"), logs);
    }

    @Test
    public void viewsCanBeMarkedPrivate() {
        View view = new View(app);
        GroundcoverViews.setGroundcoverPrivate(view, true);
        assertTrue(GroundcoverViews.getGroundcoverPrivate(view));
    }
}
