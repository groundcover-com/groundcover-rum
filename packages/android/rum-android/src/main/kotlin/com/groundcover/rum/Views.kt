@file:JvmName("GroundcoverViews")

package com.groundcover.rum

import android.view.View

/**
 * Masks the label, hint and value of every tap on this view or inside it as `***`, whatever the
 * privacy level. The counterpart of React Native's `dataPrivate`. The view itself, and what
 * TalkBack reads, are untouched. From Java: `GroundcoverViews.setGroundcoverPrivate(view, true)`.
 */
var View.groundcoverPrivate: Boolean
    get() = getTag(R.id.groundcover_private) == true
    set(value) = setTag(R.id.groundcover_private, value)
