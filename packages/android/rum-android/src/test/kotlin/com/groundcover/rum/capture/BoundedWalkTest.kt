package com.groundcover.rum.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The bounded walk the Compose text-field lookups take on every touch and key: compose-ui isn't
// on the unit tests' classpath, so it runs here on a plain tree.

class BoundedWalkTest {
    private class Node(val id: Int, val children: List<Node> = emptyList())

    private fun find(root: Node, id: Int) =
        TargetResolver.firstWithin(root, { it.children }, { it.id == id })

    @Test
    fun aNodeWithinTheBoundsIsFound() {
        val root = Node(0, listOf(Node(1), Node(2, listOf(Node(3)))))
        assertEquals(3, find(root, 3)?.id)
    }

    @Test
    fun theWalkStopsAtTheNodeBudget() {
        val wide = Node(0, (1..TargetResolver.NODE_BUDGET + 10).map { Node(it) })
        assertEquals(TargetResolver.NODE_BUDGET - 1, find(wide, TargetResolver.NODE_BUDGET - 1)?.id)
        assertNull(find(wide, TargetResolver.NODE_BUDGET + 5))
    }

    @Test
    fun theWalkStopsAtTheDepthLimit() {
        var deep = Node(TargetResolver.MAX_DEPTH + 5)
        for (id in TargetResolver.MAX_DEPTH + 4 downTo 0) deep = Node(id, listOf(deep))
        assertEquals(TargetResolver.MAX_DEPTH, find(deep, TargetResolver.MAX_DEPTH)?.id)
        assertNull(find(deep, TargetResolver.MAX_DEPTH + 1))
    }
}
