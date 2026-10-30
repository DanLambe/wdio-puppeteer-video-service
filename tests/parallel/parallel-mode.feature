Feature: parallelMode recording guard
  Scenario: the first parallel scenario runs without recording
    Given I open the red color tab
    Then the tab title is "red tab"

  Scenario: the second parallel scenario runs without recording
    Given I open the blue color tab
    Then the tab title is "blue tab"
