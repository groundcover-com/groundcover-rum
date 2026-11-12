### Changed
- **React Native — the README says which crash reporters run alongside this SDK.** One with handlers of its own does. One built on KSCrash, which is one per process, doesn't: only one of the two captures native crashes on iOS, and if this SDK installs first, the other may delete its unsent crash reports. Start such a reporter before this SDK, or leave its crash reporting out.
