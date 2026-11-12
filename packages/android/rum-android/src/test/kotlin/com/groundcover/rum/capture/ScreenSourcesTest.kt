package com.groundcover.rum.capture

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentActivity
import androidx.navigation.fragment.NavHostStandIn
import com.google.android.gms.maps.MapStandIn
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

// The screen sources and their precedence inside one Activity: a navigation destination, then a
// Fragment, then the Activity itself.

class CheckoutActivity : Activity()

class PaymentActivity : Activity()

open class OrdersFragment : Fragment() {
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View = FrameLayout(requireContext())
}

class FilterStepFragment : OrdersFragment()

/** A bottom sheet's shape: a DialogFragment with a view of its own. */
class FilterSheet : DialogFragment() {
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View = TextView(requireContext()).apply { text = "Filters" }
}

/** A bottom sheet whose steps are the app's own Fragments, as a NavHostFragment holds them. */
class FilterStepsSheet : DialogFragment() {
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View = FrameLayout(requireContext()).apply { id = STEP }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        childFragmentManager.beginTransaction().add(STEP, FilterStepFragment()).commitNow()
    }

    private companion object {
        const val STEP = 3
    }
}

/** A screen that shows its own [FilterStepsSheet], from its child Fragment manager. */
class SheetOwnerFragment : OrdersFragment() {
    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        FilterStepsSheet().showNow(childFragmentManager, "filters")
    }
}

class OrdersActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(FrameLayout(this).apply { id = CONTAINER })
        val screen = intent.getStringExtra(SCREEN) ?: OrdersFragment::class.java.name
        val fragment = supportFragmentManager.fragmentFactory.instantiate(classLoader, screen)
        supportFragmentManager.beginTransaction().add(CONTAINER, fragment).commitNow()
    }

    companion object {
        /** The Fragment to show, by class name; OrdersFragment when absent. */
        const val SCREEN = "screen"
        private const val CONTAINER = 1
    }
}

class HomeTabFragment : OrdersFragment()

class SearchTabFragment : OrdersFragment()

/** A tab that shows its screen inside it, as a NavHostFragment per tab does. */
class ProfileTabFragment : HostFragment() {
    override fun child() = OrdersFragment()
}

/** Bottom navigation by show and hide: every tab in one container, all but Home hidden. */
class BottomTabsActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(FrameLayout(this).apply { id = CONTAINER })
        val search = SearchTabFragment()
        val profile = ProfileTabFragment()
        supportFragmentManager.beginTransaction()
            .add(CONTAINER, HomeTabFragment())
            .add(CONTAINER, search)
            .add(CONTAINER, profile)
            .hide(search)
            .hide(profile)
            .commitNow()
    }

    /** Shows [tab] and hides the others, as a tap on its item in the bar does. */
    fun switchTo(tab: Class<out Fragment>) {
        val transaction = supportFragmentManager.beginTransaction()
        for (fragment in supportFragmentManager.fragments) {
            if (fragment.javaClass == tab) {
                transaction.show(fragment)
            } else {
                transaction.hide(fragment)
            }
        }
        transaction.commitNow()
    }

    private companion object {
        const val CONTAINER = 1
    }
}

/** A Fragment that shows [child] in its own view, as a tab host or a NavHost does. */
abstract class HostFragment : Fragment() {
    abstract fun child(): Fragment

    /** Whether [child] is added hidden, as a show/hide tab that isn't shown. */
    open val hidesChild = false

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View = FrameLayout(requireContext()).apply { id = CHILD }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val child = child()
        childFragmentManager.beginTransaction().add(CHILD, child)
            .apply { if (hidesChild) hide(child) }
            .commit()
    }

    private companion object {
        const val CHILD = 2
    }
}

class TabsFragment : HostFragment() {
    override fun child() = OrdersFragment()
}

/**
 * ViewPager2's shape: its FragmentStateAdapter adds the page at the RecyclerView's first layout, a
 * frame after the host resumed.
 */
class PagerFragment : Fragment() {
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View = FrameLayout(requireContext()).apply { id = PAGE }

    override fun onResume() {
        super.onResume()
        if (childFragmentManager.fragments.isNotEmpty()) return
        requireView().post {
            childFragmentManager.beginTransaction().add(PAGE, OrdersFragment()).commitNow()
        }
    }

    private companion object {
        const val PAGE = 4
    }
}

class HiddenTabHostFragment : HostFragment() {
    override fun child() = OrdersFragment()

    override val hidesChild = true
}

class StoreMapFragment : HostFragment() {
    override fun child() = MapStandIn()
}

class NavContainerFragment : HostFragment() {
    override fun child() = NavHostStandIn()
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScreenSourcesTest {
    private val reported = mutableListOf<Pair<String, String>>()

    /** One `GroundcoverNavigationEffect`, for the tests with a single NavHost. */
    private val effect = Any()

    private fun sources(activities: Boolean = true, fragments: Boolean = false) = ScreenSources(
        androidx.test.core.app.ApplicationProvider.getApplicationContext(),
        activities = activities,
        fragments = fragments
    ) { name, key -> reported.add(name to key) }.also { it.start() }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    @Test
    fun anActivityIsAScreenOnceItsFirstFrameIsPosted() {
        val sources = sources()
        Robolectric.buildActivity(CheckoutActivity::class.java).setup()
        idle()
        assertEquals(listOf("CheckoutActivity" to "CheckoutActivity-1"), reported)
        sources.stop()
    }

    @Test
    fun aDestinationInsideTheActivityWinsOverIt() {
        val sources = sources()
        val controller = Robolectric.buildActivity(CheckoutActivity::class.java)
            .create().start().resume()
        // Before the first frame, as Compose reports during the first traversal.
        sources.navigationDestination(controller.get(), effect, "Home", "entry-1")
        controller.visible()
        idle()
        assertEquals(listOf("Home" to "entry-1"), reported)
        sources.stop()
    }

    @Test
    fun aFragmentIsNotAScreenWhileADestinationRunsInItsActivity() {
        val sources = sources()
        val controller = Robolectric.buildActivity(CheckoutActivity::class.java)
            .create().start().resume()
        val activity = controller.get()
        val view = activity.window.decorView
        sources.navigationDestination(activity, effect, "Detail", "entry-2")
        sources.fragmentShown(activity, Any(), view) { true }
        sources.navigationEffectEnded(activity, effect)
        sources.fragmentShown(activity, CheckoutFragmentLike(), view) { true }
        controller.visible()
        idle()
        assertEquals(
            listOf("Detail" to "entry-2", "CheckoutFragmentLike" to "CheckoutFragmentLike-1"),
            reported
        )
        sources.stop()
    }

    @Test
    fun closingAModalsNavHostMakesTheScreenUnderItCurrentAgain() {
        // Home's NavHost, then a modal's own above it in the same Activity. Closing the modal
        // leaves Home's controller on the destination it was on, so it reports nothing.
        val sources = sources(activities = false)
        val activity = Robolectric.buildActivity(CheckoutActivity::class.java).setup().get()
        val home = Any()
        val modal = Any()
        sources.navigationDestination(activity, home, "Home", "entry-1")
        sources.navigationDestination(activity, modal, "Checkout", "entry-2")
        sources.navigationEffectEnded(activity, modal)
        idle()
        assertEquals(
            listOf("Home" to "entry-1", "Checkout" to "entry-2", "Home" to "entry-1"),
            reported
        )
        sources.stop()
    }

    @Test
    fun closingAModalsNavHostOverAPlainActivityMakesTheActivityCurrentAgain() {
        // A screen without a NavHost of its own, a modal with one above it.
        val sources = sources()
        val activity = Robolectric.buildActivity(CheckoutActivity::class.java).setup().get()
        idle()
        val modal = Any()
        sources.navigationDestination(activity, modal, "Cart", "entry-1")
        sources.navigationEffectEnded(activity, modal)
        idle()
        val checkout = "CheckoutActivity" to "CheckoutActivity-1"
        assertEquals(listOf(checkout, "Cart" to "entry-1", checkout), reported)
        sources.stop()
    }

    @Test
    fun closingAModalsNavHostOverAFragmentMakesTheFragmentCurrentAgain() {
        val sources = sources(activities = false, fragments = true)
        val activity = showing(OrdersFragment::class.java).get()
        idle()
        val modal = Any()
        sources.navigationDestination(activity, modal, "Cart", "entry-1")
        sources.navigationEffectEnded(activity, modal)
        idle()
        val orders = "OrdersFragment" to "OrdersFragment-1"
        assertEquals(listOf(orders, "Cart" to "entry-1", orders), reported)
        sources.stop()
    }

    @Test
    fun aModalOpenAtLaunchOverAFragmentGivesTheFragmentBackAsItCloses() {
        // The modal reports in the first frame, before the Fragment is decided: it never reports.
        val sources = sources(activities = false, fragments = true)
        val controller = Robolectric.buildActivity(
            OrdersActivity::class.java,
            Intent().putExtra(OrdersActivity.SCREEN, OrdersFragment::class.java.name)
        ).create().start().resume()
        val modal = Any()
        sources.navigationDestination(controller.get(), modal, "Consent", "entry-1")
        controller.visible()
        idle()
        sources.navigationEffectEnded(controller.get(), modal)
        idle()
        assertEquals(
            listOf("Consent" to "entry-1", "OrdersFragment" to "OrdersFragment-1"),
            reported
        )
        sources.stop()
    }

    @Test
    fun aFragmentReplacedUnderAnOpenModalIsTheOneGivenBack() {
        val sources = sources(activities = false, fragments = true)
        val activity = showing(OrdersFragment::class.java).get()
        idle()
        val modal = Any()
        sources.navigationDestination(activity, modal, "Cart", "entry-1")
        // A deep link, or the app's own timer, changes the screen under the modal.
        activity.supportFragmentManager.beginTransaction()
            .replace(activity.supportFragmentManager.fragments.single().id, FilterStepFragment())
            .commitNow()
        idle()
        sources.navigationEffectEnded(activity, modal)
        idle()
        assertEquals(
            listOf(
                "OrdersFragment" to "OrdersFragment-1",
                "Cart" to "entry-1",
                "FilterStepFragment" to "FilterStepFragment-1"
            ),
            reported
        )
        sources.stop()
    }

    @Test
    fun leavingAnActivityWithAModalOpenReportsNothingMoreFromIt() {
        // Back, or a rotation: the Activity goes and Compose disposes its effects, the modal's
        // first. Another Activity is the screen by then.
        val sources = sources(activities = false)
        val controller = Robolectric.buildActivity(CheckoutActivity::class.java).setup()
        val activity = controller.get()
        val home = Any()
        val modal = Any()
        sources.navigationDestination(activity, home, "Home", "entry-1")
        sources.navigationDestination(activity, modal, "Cart", "entry-2")
        controller.pause().stop()
        sources.navigationEffectEnded(activity, modal)
        sources.navigationEffectEnded(activity, home)
        controller.destroy()
        idle()
        assertEquals(listOf("Home" to "entry-1", "Cart" to "entry-2"), reported)
        sources.stop()
    }

    @Test
    fun anInnerNavHostEndingAfterItsHostNavigatedAwayReportsNothingMore() {
        // A flow's NavHost inside a destination: Back first takes the outer controller home, then
        // the flow's NavHost leaves the composition.
        val sources = sources(activities = false)
        val activity = Robolectric.buildActivity(CheckoutActivity::class.java).setup().get()
        val outer = Any()
        val flow = Any()
        sources.navigationDestination(activity, outer, "Checkout", "entry-1")
        sources.navigationDestination(activity, flow, "Cart", "entry-2")
        sources.navigationDestination(activity, outer, "Home", "entry-3")
        sources.navigationEffectEnded(activity, flow)
        idle()
        assertEquals(
            listOf("Checkout" to "entry-1", "Cart" to "entry-2", "Home" to "entry-3"),
            reported
        )
        sources.stop()
    }

    @Test
    fun aDestinationInsideAFragmentWinsOverIt() {
        // A Fragment around a Compose NavHost: the destination reports in the Fragment's first
        // frame, after the Fragment resumed.
        val sources = sources()
        val controller = Robolectric.buildActivity(CheckoutActivity::class.java)
            .create().start().resume()
        val activity = controller.get()
        sources.fragmentShown(activity, CheckoutFragmentLike(), activity.window.decorView) {
            true
        }
        sources.navigationDestination(activity, effect, "Home", "entry-1")
        controller.visible()
        idle()
        assertEquals(listOf("Home" to "entry-1"), reported)
        sources.stop()
    }

    @Test
    fun comingBackToAnActivityItsDestinationIsTheScreenAgain() {
        val sources = sources()
        val home = Robolectric.buildActivity(CheckoutActivity::class.java)
            .create().start().resume()
        sources.navigationDestination(home.get(), effect, "Home", "entry-1")
        home.visible()
        idle()
        // Another Activity on top (a payment sheet, settings), then back.
        home.pause()
        val sheet = Robolectric.buildActivity(PaymentActivity::class.java).setup()
        home.stop()
        idle()
        sheet.pause()
        home.restart().start().resume()
        sheet.stop().destroy()
        idle()
        assertEquals(
            listOf(
                "Home" to "entry-1",
                "PaymentActivity" to "PaymentActivity-1",
                "Home" to "entry-1"
            ),
            reported
        )
        sources.stop()
    }

    @Test
    fun aDialogFragmentIsNotAScreen() {
        // Dismissing it moves no Fragment back to resumed, so nothing would report the one below.
        val sources = sources(activities = false, fragments = true)
        val activity = Robolectric.buildActivity(OrdersActivity::class.java).setup().get()
        idle()
        FilterSheet().show(activity.supportFragmentManager, "filters")
        idle()
        assertEquals(listOf("OrdersFragment" to "OrdersFragment-1"), reported)
        sources.stop()
    }

    @Test
    fun theAppsFragmentsInsideADialogFragmentAreNotScreens() {
        // A sheet's steps: once it is dismissed, nothing would report the one below again.
        val sources = sources(activities = false, fragments = true)
        val activity = Robolectric.buildActivity(OrdersActivity::class.java).setup().get()
        idle()
        FilterStepsSheet().show(activity.supportFragmentManager, "filters")
        idle()
        assertEquals(listOf("OrdersFragment" to "OrdersFragment-1"), reported)
        sources.stop()
    }

    @Test
    fun aFragmentShowingASheetOfItsOwnIsStillTheScreenWhenItsActivityReturns() {
        // The sheet's steps are not screens the Fragment holds.
        val sources = sources(activities = false, fragments = true)
        showing(SheetOwnerFragment::class.java).pause().stop().restart().start().resume()
        idle()
        val owner = "SheetOwnerFragment" to "SheetOwnerFragment-1"
        assertEquals(listOf(owner, owner), reported)
        sources.stop()
    }

    private fun showing(screen: Class<out Fragment>) = Robolectric.buildActivity(
        OrdersActivity::class.java,
        Intent().putExtra(OrdersActivity.SCREEN, screen.name)
    ).setup()

    @Test
    fun aFragmentIsTheScreenAndAgainWhenItsActivityReturns() {
        val sources = sources(activities = false, fragments = true)
        showing(OrdersFragment::class.java).pause().stop().restart().start().resume()
        idle()
        val orders = "OrdersFragment" to "OrdersFragment-1"
        assertEquals(listOf(orders, orders), reported)
        sources.stop()
    }

    @Test
    fun aFragmentHoldingTheAppsOwnIsNotAScreenAtLaunchNorWhenItsActivityReturns() {
        // Children resume before their parent: the tab host would replace the tab it shows.
        val sources = sources(activities = false, fragments = true)
        showing(TabsFragment::class.java).pause().stop().restart().start().resume()
        idle()
        val orders = "OrdersFragment" to "OrdersFragment-1"
        assertEquals(listOf(orders, orders), reported)
        sources.stop()
    }

    @Test
    fun aHostWhosePageComesAFrameAfterItResumesIsNoScreenAndNeitherIsItsActivity() {
        // Decided after the first frame, by which time the page is there and has resumed.
        val sources = sources(activities = true, fragments = true)
        showing(PagerFragment::class.java).pause().stop().restart().start().resume()
        idle()
        val orders = "OrdersFragment" to "OrdersFragment-1"
        assertEquals(listOf(orders, orders), reported)
        sources.stop()
    }

    @Test
    fun onlyTheShownTabIsTheScreenAtLaunchAndWhenItsActivityReturns() {
        // A hidden tab keeps its view and resumes with the shown one, in the order it was added.
        val sources = sources(activities = false, fragments = true)
        Robolectric.buildActivity(BottomTabsActivity::class.java).setup()
            .pause().stop().restart().start().resume()
        idle()
        val home = "HomeTabFragment" to "HomeTabFragment-1"
        assertEquals(listOf(home, home), reported)
        sources.stop()
    }

    @Test
    fun theTabSwitchedToIsTheScreen() {
        // Hide and show change no lifecycle state: only the tabs' views go and come back.
        val sources = sources(activities = false, fragments = true)
        val tabs = Robolectric.buildActivity(BottomTabsActivity::class.java).setup().get()
        idle()
        tabs.switchTo(SearchTabFragment::class.java)
        idle()
        tabs.switchTo(ProfileTabFragment::class.java)
        idle()
        tabs.switchTo(HomeTabFragment::class.java)
        idle()
        val home = "HomeTabFragment" to "HomeTabFragment-1"
        val search = "SearchTabFragment" to "SearchTabFragment-1"
        // The Profile tab holds its screen: the screen is reported, not the tab.
        val profile = "OrdersFragment" to "OrdersFragment-1"
        assertEquals(listOf(home, search, profile, home), reported)
        sources.stop()
    }

    @Test
    fun aFragmentHoldingOnlyAHiddenFragmentIsStillTheScreen() {
        val sources = sources(activities = false, fragments = true)
        showing(HiddenTabHostFragment::class.java).pause().stop().restart().start().resume()
        idle()
        val host = "HiddenTabHostFragment" to "HiddenTabHostFragment-1"
        assertEquals(listOf(host, host), reported)
        sources.stop()
    }

    @Test
    fun aScreenHoldingGooglesMapFragmentIsStillTheScreen() {
        val sources = sources(activities = false, fragments = true)
        showing(StoreMapFragment::class.java)
        idle()
        assertEquals(listOf("StoreMapFragment" to "StoreMapFragment-1"), reported)
        sources.stop()
    }

    @Test
    fun anAndroidxHolderIsLookedThroughToTheAppsFragment() {
        val sources = sources(activities = false, fragments = true)
        showing(NavContainerFragment::class.java)
        idle()
        assertEquals(listOf("OrdersFragment" to "OrdersFragment-1"), reported)
        sources.stop()
    }

    @Test
    fun nothingAutomaticIsReportedOnceTrackingStops() {
        val sources = sources()
        sources.tracking = false
        val activity = Robolectric.buildActivity(CheckoutActivity::class.java).setup().get()
        sources.navigationDestination(activity, effect, "Home", "entry-1")
        idle()
        assertEquals(emptyList<Pair<String, String>>(), reported)
        sources.stop()
    }

    @Test
    fun theActivityHookOffReportsNoActivity() {
        val sources = sources(activities = false)
        Robolectric.buildActivity(CheckoutActivity::class.java).setup()
        idle()
        assertEquals(emptyList<Pair<String, String>>(), reported)
        sources.stop()
    }
}

private class CheckoutFragmentLike
