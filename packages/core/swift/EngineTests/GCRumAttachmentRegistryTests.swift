import Testing
@testable import GroundcoverRumEngine

/// The bookkeeping behind "have I already attached to this window".
///
/// Every case here is about the same hazard: `ObjectIdentifier` is derived from an
/// object's ADDRESS, so it identifies an object only while that object is alive.
/// A registry that outlives its keys stops describing reality.
struct GCRumAttachmentRegistryTests {
    /// Stands in for a `UIWindow` — the registry is deliberately generic over
    /// `AnyObject` so the judgement can be tested without UIKit.
    private final class Owner {}

    @Test func remembersALiveOwner() {
        let registry = GCRumAttachmentRegistry<String>()
        let window = Owner()

        registry.set("recognizer", for: window)

        #expect(registry.contains(window))
        #expect(registry.value(for: window) == "recognizer")
        #expect(registry.count == 1)
    }

    /**
     Address reuse is not a thought experiment: this case reproduces it.

     The owner passed to `set` is a temporary with no other reference, so it is gone
     by the next line. Against a registry that never evicted, the freshly allocated
     `Owner()` below can land on the same address, and `contains` would answer true
     for an object the registry had never been given. In the tracker that answer
     means "already attached", and the new window silently never gets a recognizer.
     */
    @Test func doesNotClaimToKnowAnOwnerItHasNotSeen() {
        let registry = GCRumAttachmentRegistry<String>()
        registry.set("recognizer", for: Owner())

        #expect(!registry.contains(Owner()))
    }

    /**
     The case the registry exists for.

     A window that goes away leaves an entry keyed by its address. Addresses are
     reused, so that entry can later compare equal to a BRAND NEW window — and the
     caller, asking "have I attached to this one already", is told yes and skips
     it. No recognizer is added and no gesture is ever measured on that window,
     with nothing anywhere reporting a problem.

     Holding the owner weakly and evicting before answering is what makes the
     answer describe live objects instead of every object that has ever existed.
     There is no way to force address reuse in a test, so what is asserted is the
     property that makes reuse harmless: once the owner is gone, the registry holds
     nothing that could collide with anything.
     */
    @Test func forgetsAnOwnerThatHasBeenDeallocated() {
        let registry = GCRumAttachmentRegistry<String>()

        do {
            let transient = Owner()
            registry.set("recognizer", for: transient)
            #expect(registry.count == 1)
        }

        // `transient` is gone; its entry describes an attachment to nothing.
        #expect(registry.count == 0)
        #expect(registry.allValues().isEmpty)
    }

    /// Teardown reaches every live attachment — the tracker has to remove each
    /// recognizer it added, so a value it cannot reach is one it cannot detach.
    @Test func exposesLiveValuesForTeardown() {
        let registry = GCRumAttachmentRegistry<String>()
        let first = Owner()
        let second = Owner()

        registry.set("first", for: first)
        registry.set("second", for: second)

        #expect(registry.allValues().sorted() == ["first", "second"])
    }

    @Test func removalHandsBackTheValueSoItCanBeUndone() {
        let registry = GCRumAttachmentRegistry<String>()
        let window = Owner()
        registry.set("recognizer", for: window)

        #expect(registry.remove(for: window) == "recognizer")
        #expect(!registry.contains(window))
        // Removing twice is not an error: a window can be torn down and then
        // reported gone, and the second pass must be a no-op rather than a crash.
        #expect(registry.remove(for: window) == nil)
    }

    /// A live owner keeps its entry through however many evictions other owners
    /// coming and going trigger — the eviction must be selective, not a reset.
    @Test func keepsALiveOwnerWhileOthersComeAndGo() {
        let registry = GCRumAttachmentRegistry<String>()
        let persistent = Owner()
        registry.set("persistent", for: persistent)

        for _ in 0..<3 {
            let transient = Owner()
            registry.set("transient", for: transient)
        }

        #expect(registry.count == 1)
        #expect(registry.value(for: persistent) == "persistent")
    }
}
