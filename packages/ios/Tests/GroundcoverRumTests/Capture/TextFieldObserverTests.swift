import Testing
import UIKit

@testable import GroundcoverRum

// One input per edit, labelled and never the text; the edit ends when the field stops editing or
// a tap lands outside it, whichever comes first.

@Suite @MainActor struct TextFieldObserverTests {
    private let center = NotificationCenter()
    private let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
    private let field = UITextField(frame: CGRect(x: 10, y: 100, width: 300, height: 40))

    init() {
        window.rootViewController = UIViewController()
        window.rootViewController?.view.addSubview(field)
        window.isHidden = false
        field.accessibilityLabel = "Search field"
        field.text = "hunter2@example.com"
    }

    private func post(_ name: Notification.Name) {
        center.post(name: name, object: field)
    }

    private func observed(_ body: (TextFieldObserver) -> Void) -> [InteractionCapture] {
        var captures: [InteractionCapture] = []
        let observer = TextFieldObserver(center: center) { captures.append($0) }
        body(observer)
        observer.stop()
        return captures
    }

    @Test func anEditThatChangedTheFieldIsOneLabelledInputWithoutTheText() {
        let captures = observed { _ in
            post(UITextField.textDidBeginEditingNotification)
            post(UITextField.textDidChangeNotification)
            post(UITextField.textDidChangeNotification)
            post(UITextField.textDidEndEditingNotification)
        }
        #expect(captures.count == 1)
        #expect(captures.first?.kind == .input)
        #expect(captures.first?.target.label == "Search field")
        #expect(captures.first?.x == nil)
        #expect(captures.first?.target.valueText == nil)
        #expect(!"\(String(describing: captures))".contains("hunter2"))
    }

    @Test func anEditThatChangedNothingSendsNothing() {
        let captures = observed { _ in
            post(UITextField.textDidBeginEditingNotification)
            post(UITextField.textDidEndEditingNotification)
        }
        #expect(captures.isEmpty)
    }

    @Test func aTapOutsideEndsTheEditAndTheLaterEndDoesNotRepeatIt() {
        let captures = observed { observer in
            post(UITextField.textDidBeginEditingNotification)
            post(UITextField.textDidChangeNotification)
            observer.tapped(at: CGPoint(x: 100, y: 120), in: window)
            observer.tapped(at: CGPoint(x: 100, y: 500), in: window)
            post(UITextField.textDidEndEditingNotification)
        }
        #expect(captures.count == 1)
    }

    @Test func aTapInsideTheFieldIsStillEditing() {
        let captures = observed { observer in
            post(UITextField.textDidBeginEditingNotification)
            post(UITextField.textDidChangeNotification)
            observer.tapped(at: CGPoint(x: 100, y: 120), in: window)
        }
        #expect(captures.isEmpty)
    }
}
