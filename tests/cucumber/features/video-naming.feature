Feature: Video artifact naming
  Scenario: cucumber style should keep scenario name in video filename
    Given I open the internet home page
    Then I should see the internet home page title
    And I wait briefly for recording stability
