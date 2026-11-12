package com.google.android.gms.maps

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.fragment.app.Fragment

/**
 * A stand-in in SupportMapFragment's package: Google's Fragment with a view, part of the app's
 * screen. The screen rule tells the two by package; play-services-maps isn't on the unit tests'
 * classpath.
 */
class MapStandIn : Fragment() {
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View = FrameLayout(requireContext())
}
