package com.groundcover.nativeplayground

import android.os.Bundle
import android.util.Log
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import androidx.fragment.compose.AndroidFragment
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.groundcover.nativeplayground.screens.ConfigScreen
import com.groundcover.nativeplayground.screens.CustomScreen
import com.groundcover.nativeplayground.screens.DetailFragment
import com.groundcover.nativeplayground.screens.HomeScreen
import com.groundcover.nativeplayground.screens.LogsScreen
import com.groundcover.nativeplayground.screens.NativeScreen
import com.groundcover.nativeplayground.screens.NetworkScreen
import com.groundcover.rum.compose.GroundcoverNavigationEffect

/** The six tabs, by label, and the route each one opens. */
private val tabs =
    listOf(
        "Taps" to "Home",
        "Network" to "Network",
        "Logs" to "Logs",
        "Custom" to "Custom",
        "Native" to "Native",
        "Config" to "Config",
    )

/**
 * The playground: one route per screen, with RN's route names (Home, Detail, Network, Logs,
 * Custom, Native, Config), because the specs assert them as `screen.name`.
 *
 * Tabs are routes on the one NavController GroundcoverNavigationEffect watches, so a tab switch
 * is a navigation the SDK can see, as React Navigation's tab switches are in RN. Detail is pushed
 * on top of Home, like RN's stack inside the Taps tab, and is a Fragment: the Compose screens and
 * the Fragment are the two toolkits the SDK's screen tracking has to tell apart. A
 * FragmentActivity, so the Fragment has a manager to live in.
 */
class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Playground()
            }
        }
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun Playground() {
    val navController = rememberNavController()
    GroundcoverNavigationEffect(navController)
    LaunchedEffect(Unit) {
        // CI's Android script waits for this logcat line before running specs: the SDK has
        // started (PlaygroundApp.onCreate) and the first frame is up.
        withFrameNanos {}
        Log.i("NativePlayground", "native-playground: ready (preset: ${PlaygroundApp.preset})")
    }
    Column(
        modifier =
            Modifier
                .fillMaxSize()
                .background(Color.White)
                .safeDrawingPadding()
                // Test tags become resource ids, which is what getByTestId reads on Android.
                .semantics { testTagsAsResourceId = true },
    ) {
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            NavHost(
                navController = navController,
                startDestination = "Home",
                // A tab switch is instant, as in RN.
                enterTransition = { EnterTransition.None },
                exitTransition = { ExitTransition.None },
                popEnterTransition = { EnterTransition.None },
                popExitTransition = { ExitTransition.None },
            ) {
                composable("Home") { HomeScreen(onDetail = { navController.navigate("Detail") }) }
                composable("Detail") {
                    AndroidFragment<DetailFragment>(
                        modifier = Modifier.fillMaxSize(),
                        onUpdate = { fragment -> fragment.onBack = { navController.popBackStack() } },
                    )
                }
                composable("Network") { NetworkScreen() }
                composable("Logs") { LogsScreen() }
                composable("Custom") { CustomScreen() }
                composable("Native") { NativeScreen() }
                composable("Config") { ConfigScreen(preset = PlaygroundApp.preset) }
            }
        }
        TabBar(navController)
    }
}

@Composable
private fun TabBar(navController: NavHostController) {
    val entry by navController.currentBackStackEntryAsState()
    val route = entry?.destination?.route ?: "Home"
    val activeTab = if (route == "Detail") "Home" else route
    Row(modifier = Modifier.fillMaxWidth().background(Color(0xFFF7F7F7))) {
        for ((label, target) in tabs) {
            val active = activeTab == target
            val open = {
                if (route != target) {
                    navController.navigate(target) {
                        popUpTo(navController.graph.id) { inclusive = true }
                    }
                }
            }
            // One node per tab, its visible text cleared: specs, and tapScrolling's tab-bar
            // measurement, locate tabs by this exact label, and getByText("Taps") must find the
            // Taps screen's title rather than its tab.
            Box(
                contentAlignment = Alignment.Center,
                modifier =
                    Modifier
                        .weight(1f)
                        .clickable(onClick = open)
                        .clearAndSetSemantics {
                            contentDescription = "$label tab"
                            role = Role.Tab
                            selected = active
                            onClick {
                                open()
                                true
                            }
                        }.padding(vertical = 14.dp),
            ) {
                Text(
                    label,
                    fontSize = 12.sp,
                    fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                    color = if (active) MaterialTheme.colorScheme.primary else Color.DarkGray,
                )
            }
        }
    }
}
