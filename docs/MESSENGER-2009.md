# Windows Live Messenger 2009 fidelity baseline

Research and implementation review: September 6, 2026.

## Sources inspected before implementation

- [Microsoft, September 17, 2008](https://blogs.windows.com/windowsexperience/2008/09/17/next-wave-of-windows-live-introduced-with-new-betas/): Wave 3 lighter palette, scenes, glowing presence frames, favorites, hover actions and photo sharing. This is beta-era evidence, distinguished from final screenshots.
- [Microsoft, August 12, 2009](https://blogs.windows.com/windowsexperience/2009/08/12/customizing-your-windows-live-messenger-contact-list/): favorites, groups, offline visibility, contact sizes and What's New. Its “tab bar” means content/service tabs in the contact list, not conversation tabs.
- [Pinnula contemporary release capture](https://static.pinnula.fr/news/i/windows-live-messenger-2009.png): visually inspected the narrow contact window, left conversation portrait rail, thin toolbar, separate chat window and composer placement. [Release article](https://www.pinnula.fr/news/02896-windows-live-essentials-released/fr/).
- [Super User 2009 login question](https://superuser.com/questions/233808/live-messenger-wont-sign-in-automatically) and [login image](https://i.sstatic.net/0U0WI.png): visually inspected avatar near the top, faceted blue fading into white, compact fields, presence selector, remember controls and restrained sign-in button.
- [Contemporary report about future conversation tabs](https://arstechnica.com/information-technology/2009/11/will-messenger-finally-get-tabbed-conversations/): corroborates excluding native conversation tabs from 2009.
- A Geardownload image returned for a 2009 search showed an earlier visual generation and an add-on. Rejected as an implementation reference. Search labels alone are insufficient evidence.

## Implemented changes

- One independent movable conversation window per contact; no chat tabs or automatic second conversation.
- Each window retains its own draft, transcript, minimize/restore state and stacking position. The Conversations control restores windows without an OS taskbar.
- A compact, single-column contact window with favorites, groups, offline section and What's New, replacing the prior full-width two-column layout.
- Reduced profile, contact rows, title bars, toolbar, composer and footer to match the 2009 proportions.
- Left portrait rail and thin blue text toolbar, without the larger mixed-era toolbar icons.
- Fullscreen web login retains its required viewport behavior, while adopting the 2009 top-positioned portrait and blue-to-white composition.
- The signed-in desktop uses an original teal and green aurora wallpaper, following the user's supplied desktop reference. Login keeps its existing background; no OS taskbar is introduced.
- Both the contact list and conversation windows can be dragged by their title bars and brought to the front by pointer or keyboard focus. Movement stays within the viewport and resize keeps title bars reachable. Focused title bars also support Alt + arrow keys, with Shift for fine movement.
- A labeled advertising placement sits below What's New in the contact list. Its local preview opens a placement information dialog; it does not load an advertising network or third-party tracking.

## Explicit adaptations and limits

This is a reconstruction of the 2009 interface for Bot Messenger, not a binary or pixel-identical copy of Microsoft software. Product name, AI contact identities, illustrations, bot commands and local demo notices remain specific to this app. The implementation does not copy Microsoft account flows, advertisements, OS taskbar, proprietary logos or raw-password storage. Selawik remains the bundled fallback when Segoe UI is unavailable. Signup remains an in-app flow as requested earlier, whereas historical service signup involved Microsoft's account system.

`../agent-messenger` is retained as the prior approved mixed-era reference; the active Next.js app is now the 2009 implementation. This document supersedes the earlier 2009–2011 style policy. Visual edits must reference the 14.x / Wave 3 generation, not 2011 social view or conversation tabs.
