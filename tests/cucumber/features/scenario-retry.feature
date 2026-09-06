Feature: Scenario retry recording
  Scenario: cucumber style should record the retried scenario attempt
    Given I open the static video fixture
    Then I fail only the first scenario attempt
