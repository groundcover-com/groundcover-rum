@file:JvmName("GroundcoverCompose")

package com.groundcover.rum.compose

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.semantics
import androidx.navigation.NavController
import com.groundcover.rum.internal.GroundcoverInternal
import com.groundcover.rum.internal.InternalGroundcoverApi

/**
 * Masks the label, hint and value of every tap inside this element as `***`, whatever the privacy
 * level. The Compose counterpart of `View.groundcoverPrivate`. What TalkBack reads is untouched.
 */
fun Modifier.groundcoverPrivate(): Modifier = semantics { this[GroundcoverPrivateKey] = true }

/** Read by name in rum-android's tap capture; TalkBack ignores keys it doesn't know. */
private val GroundcoverPrivateKey = SemanticsPropertyKey<Boolean>("GroundcoverPrivate")

/**
 * Reports [navController]'s destinations as screens, each named by its route, for as long as it
 * stays in the composition. When it leaves (a modal's own NavHost closing), the screen under it is
 * current again. Call it once, beside the `NavHost` it drives:
 *
 * ```kotlin
 * val navController = rememberNavController()
 * GroundcoverNavigationEffect(navController)
 * NavHost(navController, startDestination = "home") { … }
 * ```
 */
@OptIn(InternalGroundcoverApi::class)
@Composable
fun GroundcoverNavigationEffect(navController: NavController) {
    val activity = LocalContext.current.findActivity()
    DisposableEffect(navController, activity) {
        // This effect, told apart from another NavHost's in the same Activity.
        val effect = Any()
        val listener = NavController.OnDestinationChangedListener { controller, destination, _ ->
            val name = destination.route ?: destination.label?.toString() ?: ""
            val key = controller.currentBackStackEntry?.id ?: name
            GroundcoverInternal.navigationDestination(activity, effect, name, key)
        }
        navController.addOnDestinationChangedListener(listener)
        onDispose {
            navController.removeOnDestinationChangedListener(listener)
            GroundcoverInternal.navigationEffectEnded(activity, effect)
        }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
