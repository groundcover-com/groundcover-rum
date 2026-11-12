#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// REMAP, not plain RCT_EXTERN_MODULE: the plain form leaves the JS name empty,
// and React Native then derives it from the class name, stripping only an
// `RCT`/`RK` prefix — never a `Module` suffix. The module would register as
// `NativeModules.GroundcoverRumModule` while JavaScript looks up
// `NativeModules.GroundcoverRum`, come back undefined, and every native feature
// would silently no-op exactly as it does in Expo Go. Naming it here also keeps
// it identical to Android's `getName()`.
//
// Arguments: JS name, class, superclass.
@interface RCT_EXTERN_REMAP_MODULE (GroundcoverRum, GroundcoverRumModule, RCTEventEmitter)

RCT_EXTERN_METHOD(nativeInit
                  : (NSString *)configJson resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(updateSessionSnapshot : (nullable NSString *)snapshotJson)

RCT_EXTERN_METHOD(getPendingCrashReports
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(clearPendingCrashReports
                  : (NSArray<NSString *> *)ids resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(flushFrameSegment
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stop)

// Development-build-only e2e triggers; the Swift implementations return at once
// in an App Store build (see `isDevelopmentBuild`), so exporting them here costs
// nothing in a shipped app.
RCT_EXTERN_METHOD(triggerTestCrash : (NSString *)kind)
RCT_EXTERN_METHOD(blockMainThread : (double)ms)

@end
