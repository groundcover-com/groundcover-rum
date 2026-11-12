package com.groundcover.nativeplayground.screens

import android.os.Bundle
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import androidx.fragment.app.Fragment
import com.groundcover.nativeplayground.R

/**
 * The Detail screen: a View-based Fragment pushed on top of Home, so the SDK's Fragment lifecycle
 * hook has a real one to see beside the Compose screens. Hosted by the NavHost's Detail route
 * (AndroidFragment), which hands it [onBack].
 */
class DetailFragment : Fragment(R.layout.fragment_detail) {
    var onBack: () -> Unit = {}

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val back = view.findViewById<Button>(R.id.detail_back)
        back.setOnClickListener { onBack() }
        // The test id as Compose's testTag gives it (and RN's testID): the bare string as the
        // resource id, not this app's R.id name.
        back.accessibilityDelegate =
            object : View.AccessibilityDelegate() {
                override fun onInitializeAccessibilityNodeInfo(
                    host: View,
                    info: AccessibilityNodeInfo,
                ) {
                    super.onInitializeAccessibilityNodeInfo(host, info)
                    info.viewIdResourceName = "detail-back"
                }
            }
    }
}
