# System Design Interactive

A browser-only app where a junior developer learns system design by changing a simulation and
watching the outcome change.

## Language

### Learning content

**Concept**:
One system design idea with its own page. The unit the learner studies and completes. Every Concept has
four tabs - Diagram, Lab, Trade-offs, Quiz - and a Lesson under its Diagram.
_Avoid_: Lesson, topic, page

**Category**:
A named group of Concepts, such as Scaling or Caching. Every Concept belongs to exactly one.
_Avoid_: Section, module, chapter

**Lesson**:
The long-form written explanation of one Concept, shown in the Diagram tab, under the Diagram. It is
not a tab of its own.
_Avoid_: Deep dive, article

**Diagram**:
The running picture of one Concept: its parts and the traffic that flows between them. The first thing a Concept shows.
It may be shorter than the Lab of its Concept, but it never contradicts it: the same Example product, the same parts
under the same names, the same order of steps, and the same shape for the same outcome.
_Avoid_: Visual, flow, animation

**Walkthrough**:
The ordered steps of a Diagram, one hop at a time, each with a caption of six words or fewer. Shown on the same Diagram, not beside it. Every Concept has one.
_Avoid_: Step by step, sequence, tour

**Lab**:
An interactive simulation the learner drives with controls. It always shows the system as parts and
wires with traffic moving on them; a chart or a timeline may sit beside that picture, never replace it.
Every Concept hosts exactly one Lab. One Lab can be hosted by several Concepts, and it also has a page
of its own.
_Avoid_: Demo, exercise, widget

**Lab focus**:
The starting setup a shared Lab opens with on one Concept, so it shows that Concept's lesson first.
Retry and Exponential backoff share a Lab; each opens it with a different focus.
A Lab focus opens on the controls of its own Concept, so the first change the learner makes teaches that Concept.
Two Concepts whose focuses start almost the same is a defect, not a shortcut.
_Avoid_: Preset, mode, scenario

**Example product**:
The real product a Concept uses as its worked example, such as WhatsApp, Instagram or Uber. A Concept's Diagram and
its Lab focus use the same one, so the Lab reads as the Diagram made adjustable, and its Lesson's worked example
uses it too. Its Quiz may use other products, to check the idea carries over. Only a Concept whose Lab offers a
choice of products has one; the others keep a general example such as example.com.
_Avoid_: Scenario (that is a Tool), preset, case study

**Trade-offs**:
What each approach to a Concept gains and what it costs. Never "X is better than Y".
_Avoid_: Pros and cons, comparison

**Quiz**:
The scenario questions that check one Concept - at least ten, and more when ten cannot cover it.
Passing it with 70% or more makes the Concept Done.
_Avoid_: Test, exam, questions

### Tools

**Tools**:
The six pages that sit above the Categories in the sidebar: Interactive Labs, Playground, System
Evolution, Compare Mode, Scenarios and Glossary. They are not tied to one Concept.
_Avoid_: Workspace, features, sections

**Playground**:
The free-build canvas where the learner adds parts, wires them and runs traffic to see what breaks.
Unlike a Lab, it has no set lesson and no fixed parts.
_Avoid_: Sandbox, editor, builder

### People

**Learner**:
The person who studies in the app. A Learner can use every page with or without an Account.
_Avoid_: User, student, visitor

**Account**:
The sign-in identity of a Learner, by email and password or by Google. It exists so the progress of
a Learner is saved on the server: it follows them to another device and survives a cleared browser.
Only progress is saved to it - theme and folded panels stay with the device. When a Guest signs in,
their progress on this device merges into the Account: nothing is lost, and for each Concept the
latest change wins, so un-marking Done on one device also un-marks it on the others; a Quiz keeps
its best score. Resetting progress while signed in clears it on the Account, on every device. The
Learner can delete their Account, and with it everything saved to it; every other device signed in to
it then becomes an empty Guest. A Learner has one Account per email address: signing in with Google
or with a password for the same email opens the same Account.
_Avoid_: Profile, login, user

**Guest**:
A Learner with no Account, or signed out. Their progress lives only in this browser, as it always did.
Signing out leaves an empty Guest, so the next person on a shared computer sees nothing.
_Avoid_: Anonymous user, visitor

### Progress

**Done**:
A Concept the learner marked complete or whose quiz they passed with 70% or more. Opening a Concept does not make it Done.
_Avoid_: Finished, learned, visited

## Flagged ambiguities

- "Learning path" (an ordered list of Concepts to follow) was discussed on 2026-09-23 and deferred.
  No Concept has a set order or prerequisites today.
