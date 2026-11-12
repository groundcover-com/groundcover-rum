import * as React from "react";
import { LogBox } from "react-native";
import { StatusBar } from "expo-status-bar";

// The dev-mode LogBox notification ("Open debugger to view warnings") docks at
// the bottom of the screen and overlays the bottom tab bar — taps meant for a
// tab land on the banner instead, so tab navigation silently fails in e2e.
// Disable it; this is a dev build driven only by automation, so the banner has
// no value here.
LogBox.ignoreAllLogs(true);
import { NavigationContainer, useNavigationContainerRef } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import groundcover, { GroundcoverProvider } from "@groundcover/react-native";

import { HomeScreen } from "./src/screens/HomeScreen";
import { DetailScreen } from "./src/screens/DetailScreen";
import { NetworkScreen } from "./src/screens/NetworkScreen";
import { LogsScreen } from "./src/screens/LogsScreen";
import { CustomScreen } from "./src/screens/CustomScreen";
import { NativeScreen } from "./src/screens/NativeScreen";
import { ConfigScreen } from "./src/screens/ConfigScreen";
import { ACTIVE_PRESET, configFor } from "./src/config-presets";

// init at MODULE TOP, on purpose: this fires before the first component renders
// and before storage hydration completes, so it exercises the SDK's async-init +
// pre-ready call-buffering path end to end.
//
// The config comes from a preset compiled in at bundle time (src/e2e-preset.ts),
// which is what keeps this call synchronous — see that file for why an async
// lookup here would break navigation tracking rather than merely delay it.
groundcover.init(configFor(ACTIVE_PRESET));

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function HomeStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="Home" component={HomeScreen} />
      <Stack.Screen name="Detail" component={DetailScreen} />
    </Stack.Navigator>
  );
}

export default function App() {
  const navigationRef = useNavigationContainerRef();

  return (
    <GroundcoverProvider>
      <NavigationContainer
        ref={navigationRef}
        onReady={() => groundcover.startNavigationTracking(navigationRef)}
      >
        <StatusBar style="auto" />
        <Tab.Navigator>
          {/* Explicit tabBarAccessibilityLabel gives each tab button a clean,
              unique accessible name so e2e can target the interactive tab via
              getByLabel on both platforms (iOS otherwise exposes a composite
              "<title>, tab, N of M" label that plain text matching misses). */}
          <Tab.Screen name="HomeTab" component={HomeStack} options={{ title: "Taps", tabBarAccessibilityLabel: "Taps tab" }} />
          <Tab.Screen name="Network" component={NetworkScreen} options={{ tabBarAccessibilityLabel: "Network tab" }} />
          <Tab.Screen name="Logs" component={LogsScreen} options={{ tabBarAccessibilityLabel: "Logs tab" }} />
          <Tab.Screen name="Custom" component={CustomScreen} options={{ tabBarAccessibilityLabel: "Custom tab" }} />
          <Tab.Screen name="Native" component={NativeScreen} options={{ tabBarAccessibilityLabel: "Native tab" }} />
          <Tab.Screen name="Config" component={ConfigScreen} options={{ tabBarAccessibilityLabel: "Config tab" }} />
        </Tab.Navigator>
      </NavigationContainer>
    </GroundcoverProvider>
  );
}
