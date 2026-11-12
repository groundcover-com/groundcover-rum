package androidx.compose.ui.node

/**
 * A stand-in with the name of the interface the tap capture tells a Compose view by, with none of
 * its members: the capture finds no semantics and names the view as a View. compose-ui is compiled
 * against, never on the unit tests' classpath.
 */
interface RootForTest
