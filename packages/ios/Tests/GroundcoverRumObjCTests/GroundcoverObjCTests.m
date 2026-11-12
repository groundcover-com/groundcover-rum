@import Foundation;
@import UIKit;
@import XCTest;
@import GroundcoverRum;
@import GroundcoverRumObjC;

// The Objective-C facade as an Objective-C host calls it. Mostly a compile check: a selector the
// facade renames fails this file.

@interface GroundcoverObjCTests : XCTestCase
@end

@implementation GroundcoverObjCTests

- (GroundcoverConfig *)configWithAppId:(NSString *)appId {
    return [[GroundcoverConfig alloc] initWithApiKey:@"your-rum-ingestion-key"
                                                 dsn:@"https://example.platform.grcv.io"
                                             cluster:@"your-cluster"
                                         environment:@"production"
                                               appId:appId];
}

- (void)testTheQuickStartStarts {
    NSError *error = nil;
    XCTAssertTrue([Groundcover startWithConfig:[self configWithAppId:@"my-ios-app"] error:&error]);
    XCTAssertNil(error);
}

- (void)testABlankAppIdFailsTheStartWithItsReason {
    NSError *error = nil;
    XCTAssertFalse([Groundcover startWithConfig:[self configWithAppId:@" "] error:&error]);
    XCTAssertEqualObjects(error.localizedDescription, @"start requires a nonblank appId");
}

- (void)testAnUnknownEventNameFailsTheStartRatherThanEnablingEverything {
    GroundcoverConfig *config = [self configWithAppId:@"my-ios-app"];
    config.enabledEvents = @[ @"crash" ];
    NSError *error = nil;
    XCTAssertFalse([Groundcover startWithConfig:config error:&error]);
    XCTAssertTrue([error.localizedDescription containsString:@"crash"]);
}

- (void)testAnExcludedUrlThatIsNeitherAStringNorARegexFailsTheStart {
    GroundcoverConfig *config = [self configWithAppId:@"my-ios-app"];
    config.excludedUrls = @[ [NSURL URLWithString:@"https://api.example.com/secret"] ];
    NSError *error = nil;
    XCTAssertFalse([Groundcover startWithConfig:config error:&error]);
    XCTAssertTrue([error.localizedDescription containsString:@"excludedUrls"]);
}

- (void)testEveryOptionCanBeSet {
    GroundcoverConfig *config = [self configWithAppId:@"my-ios-app"];
    config.namespaceName = @"ns";
    config.releaseId = @"1.0.0";
    config.user = [[GroundcoverUser alloc] initWithId:@"u_123"];
    config.sessionId = @"fixed";
    config.enabledEvents = @[ @"interaction", @"crashes", @"appStart" ];
    config.sessionSampleRate = @0.5;
    config.sessionMaxDuration = @7200;
    config.debug = @YES;
    config.excludedUrls = @[
        @"https://api.example.com/health",
        [NSRegularExpression regularExpressionWithPattern:@"/metrics$" options:0 error:nil],
    ];
    config.privacyLevel = GroundcoverPrivacyLevelMaskAll;
    config.sensitiveKeys = @[ @"pin", @"otp" ];
    config.maskInteractionLabels = @YES;
    config.beforeSend = ^BOOL(GroundcoverEvent *event) {
        return ![event.type isEqualToString:@"log"];
    };
    config.enrichEvent = ^(GroundcoverEvent *event) {
        NSMutableDictionary *attributes = [event.attributes mutableCopy];
        [attributes removeObjectForKey:@"email"];
        event.attributes = attributes;
    };
    config.propagationUrls = @[ @"https://api.myapp.com/*" ];
    config.batchSize = @20;
    config.batchTimeout = @5;
    config.compression = @NO;
    config.appVersion = @"1.2.3";
    config.appBuild = @"45";
    config.hangThreshold = @1;
    config.vitalsMaxSegment = @30;
    config.manualTimeToInteractive = YES;
    config.viewControllerHook = NO;
    config.touchesHook = YES;
    config.textFieldsHook = NO;
    config.urlSessionHook = NO;
    NSError *error = nil;
    XCTAssertTrue([Groundcover startWithConfig:config error:&error]);
}

- (void)testEveryCallIsAvailable {
    GroundcoverUser *user = [[GroundcoverUser alloc] initWithId:@"u_123"];
    user.email = @"demo@example.com";
    user.properties = @{ @"plan" : @"pro" };
    [Groundcover identifyUser:user];
    [Groundcover clearUser];
    [Groundcover sendCustomEvent:@"plan_upgraded" attributes:@{ @"plan" : @"pro" }];
    [Groundcover captureError:[NSError errorWithDomain:@"pay" code:1 userInfo:nil]
                     metadata:@{ @"step" : @"pay" }];
    [Groundcover logWithLevel:GroundcoverLogLevelWarn
                      message:@"Payment retry"
                   attributes:@{ @"attempt" : @2 }];
    (void)Groundcover.sessionId;
    XCTestExpectation *adopted = [self expectationWithDescription:@"setSessionId completes"];
    [Groundcover setSessionId:@"fixed" completion:^{ [adopted fulfill]; }];
    [self waitForExpectations:@[ adopted ] timeout:5];
    [Groundcover startNavigation:@"Checkout" key:nil metadata:nil];
    [Groundcover endNavigation:@{ @"paid" : @YES }];
    [Groundcover stopNavigationTracking];
    [Groundcover markAppInteractive];
    [GroundcoverTesting backdateLastActivityBy:0];
    [GroundcoverTesting forgetSession];
}

- (void)testViewsCanBeMarkedPrivate {
    UIView *view = [[UIView alloc] init];
    view.groundcoverPrivate = YES;
    XCTAssertTrue(view.groundcoverPrivate);
}

@end
