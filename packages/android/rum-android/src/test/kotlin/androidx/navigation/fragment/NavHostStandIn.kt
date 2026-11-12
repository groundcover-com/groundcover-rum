package androidx.navigation.fragment

import com.groundcover.rum.capture.HostFragment
import com.groundcover.rum.capture.OrdersFragment

/**
 * A stand-in in NavHostFragment's package: an androidx Fragment that holds the app's screen. The
 * screen rule tells the two by package; navigation-fragment isn't on the unit tests' classpath.
 */
class NavHostStandIn : HostFragment() {
    override fun child() = OrdersFragment()
}
