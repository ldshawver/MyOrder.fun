# Screenshot protection in MyOrder.fun

MyOrder.fun's web/PWA privacy mode is a best-effort deterrence and traceability layer. Browsers do not provide a reliable API that can fully prevent screenshots, screen recordings, external cameras, or operating-system capture tools.

The web implementation therefore focuses on:

- visible watermarks with the viewer email, role, company/tenant, and timestamp;
- hiding sensitive screens from print/export with print CSS;
- blurring or covering sensitive content when the tab, PWA, or app loses focus or goes into the background;
- disabling context menu, drag, and text selection only inside sensitive wrappers while preserving form input behavior;
- warning users when Print Screen or print shortcuts are detectable; and
- audit logging privacy events without trusting client-submitted user, tenant, or role metadata.

Native apps can provide stronger controls:

- Android can use `FLAG_SECURE` to prevent screenshots and screen recording for protected windows.
- iOS can detect screen capture/screen recording state and use secure-view patterns, although behavior varies by OS version and implementation.

For MyOrder.fun web/PWA, treat privacy mode as deterrence + watermark + audit, not absolute screenshot blocking.
